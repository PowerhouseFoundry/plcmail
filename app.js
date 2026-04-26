import { db, doc, getDoc, setDoc, onSnapshot } from "./firebase-init.js";
const STORAGE_KEY = 'plcmail_local_v3';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const TEMPLATE_GROUPS = ['Everyday safe emails','Internal staff emails','Spam / junk','Phishing / scam'];
const fakePages = {
  'fake-bank': { title:'Lloyds Secure Verification', fields:['Full name','Card number','Sort code','Online banking password'] },
  'fake-delivery': { title:'Royal Mail Redelivery', fields:['Full name','Address','Bank card number','Expiry date'] },
  'fake-tax': { title:'HMRC Refund Release', fields:['Full name','Sort code','Account number','Card security code'] },
  'fake-subscription': { title:'Netflix Billing Update', fields:['Email address','Password','Card number'] },
  'fake-email': { title:'Outlook Mailbox Upgrade', fields:['Email address','Password'] },
  'fake-paypal': { title:'PayPal Security Review', fields:['Email address','Password','Card number'] }
};
const PLCMAIL_DOC = doc(db, "plcMailState", "current");
let startedFirestoreSync = false;
let saveQueue = Promise.resolve();
let state = null;
let currentUserId = null;
let adminSection = 'dashboard';
let mailFolder = 'inbox';
let selectedMailId = null;
let selectedTemplateId = '';
let composeMode = null;
let showHint = false;
let searchTerm = '';
let libraryGroupFilter = '';
let selectedMailboxClassId = '';
let selectedMailboxStudentId = '';
let monitoredMailboxUserId = '';
let monitoredMailboxFolder = 'inbox';
let monitoredMailboxSelectedMailId = '';
let studentManageClassId = '';
let sendEmailMode = 'menu';
let composeSelectedTo = [];
let composeSelectedCc = [];
let composeRecipientMode = 'to';

function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,10); }
function esc(t){ return String(t ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function initials(name){ return String(name||'').split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase(); }
function shortTime(){ return new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
function timestamp(){ return new Date().toLocaleString(); }
function todayKey(){ const d=new Date(); return d.toISOString().slice(0,10); }
function weekdayNum(){ const d = new Date().getDay(); return d === 0 ? 7 : d; }
function openModal(html, mode='default'){ const card=document.getElementById('modalCard'); card.className='card' + (mode==='narrow'?' narrow':mode==='compact'?' compact':''); card.innerHTML=html; document.getElementById('modalOverlay').classList.remove('hidden'); }
function closeModal(){ document.getElementById('modalOverlay').classList.add('hidden'); document.getElementById('modalCard').innerHTML=''; }
function setMessage(el, type, text){ el.innerHTML = '<div class="message '+type+'">'+text+'</div>'; }
function getUser(id){
  if(!state || !state.users) return null;
  return state.users.find(u=>u.id===id) || null;
}
function currentUser(){ return getUser(currentUserId); }
function isStaffUser(){
  const user = currentUser();
  return user && user.role === 'staff';
}
function isTeacherUser(){
  const user = currentUser();
  return user && user.role === 'teacher';
}
function className(id){ return state.classes.find(c=>c.id===id)?.name || ''; }
function saveState(){
  ensureStateShape();

  const cleanState = clone(state);
  state = cleanState;

  saveQueue = saveQueue
    .then(async ()=>{
      await setDoc(PLCMAIL_DOC, cleanState);
    })
    .catch((error)=>{
      console.error("Failed to save PLC Mail state:", error);
    });

  return saveQueue;
}
function waitForPendingSave(){
  return saveQueue;
}
function fullEmail(username){ return username.includes('@') ? username : username + '@plcmail.com'; }
function parseAttachments(text){ return String(text||'').split(',').map(s=>s.trim()).filter(Boolean).map(name=>({id:uid('att'), filename:name, filetype:(name.split('.').pop()||'FILE').toUpperCase(), size:'Local file'})); }
function folderLabel(folder){ return folder==='junk'?'Junk Email':folder==='deleted'?'Deleted Items':folder==='sent'?'Sent Items':'Inbox'; }
function userLabel(userId){ const u=getUser(userId); return u ? (u.displayName + ' (' + u.email + ')') : ''; }
function monitorableMailboxUsers(){ return state.users.filter(u=>u.active && (u.role==='teacher' || u.role==='staff')); }
function monitoredMailbox(){ return getUser(monitoredMailboxUserId); }

function buildTemplates(){
  const hintsSafe=[{target:'from',label:'Check the sender address'},{target:'body',label:'Look for whether the message sounds calm and expected'}];
  const hintsPh=[{target:'from',label:'Check the sender email address'},{target:'body',label:'Look for spelling mistakes'},{target:'body',label:'Look for urgency or threats'},{target:'body',label:'Check whether the link looks official'}];
  const raw=[
    ['Everyday safe emails','safe','Amazon Orders','dispatch@amazon-mail.co.uk','Your parcel will arrive tomorrow','Your order will arrive tomorrow morning.','Hello {{name}},\n\nYour order has now been dispatched and is due for delivery tomorrow between 9:00 and 11:00.\n\nOrder reference: {{ref}}\nDelivery address: {{address}}\n\nThank you for shopping with us.\n\nAmazon Customer Service','',hintsSafe,'inbox'],
    ['Everyday safe emails','safe','The Foundry Payroll','payroll@thefoundryoffice.co.uk','Payslip available for March','Your March payslip is now ready to view.','Hello {{name}},\n\nYour payslip for March is now available in the staff portal.\n\nIf you have any questions, reply to this message and the payroll team will help.\n\nPayroll Department','',hintsSafe,'inbox'],
    ['Everyday safe emails','safe','West SILC Appointments','appointments@westsilc-support.org','Reminder: travel training review meeting','This is a reminder for your review meeting on Friday.','Good morning {{name}},\n\nThis is a reminder that your travel training review meeting is booked for Friday at 10:30.\n\nIf you can no longer attend, please reply to this email.\n\nKind regards,\nStudent Support Team','',hintsSafe,'inbox'],
    ['Everyday safe emails','safe','Royal Mail','updates@royalmail-track.co.uk','Delivery update for item REF-40321','Your parcel is due today and is out for delivery.','Hello {{name}},\n\nYour item REF-40321 is currently out for delivery and should arrive today.\n\nYou can check tracking using your usual Royal Mail account if needed.\n\nThank you for using Royal Mail.','',hintsSafe,'inbox'],
    ['Internal staff emails','internal','Teacher Admin','teacher@plcmail.com','Timetable reminder for tomorrow','Please check your timetable before arriving.','Hello {{name}},\n\nPlease check your timetable before arriving tomorrow.\n\nTeacher Admin','',hintsSafe,'inbox'],
    ['Internal staff emails','internal','Support Team','support.team@plcmail.com','Work placement check-in','Please come to reception at 09:30 for your check-in.','Hello {{name}},\n\nPlease come to reception at 09:30 for your work placement check-in.\n\nSupport Team','',hintsSafe,'inbox'],
    ['Spam / junk','spam','Quick Loans UK','apply@cash-now-fast-win.biz','Instant approval today!!!','Borrow up to £5,000 now, no checks.','Need money fast? We can help everybody. No checks. No problem. Approved in minutes!!!\n\nClick now and claim your cash reward loan.','', [{target:'body',label:'Look at the tone and punctuation'},{target:'body',label:'Check whether it feels professional'}],'junk'],
    ['Spam / junk','spam','Prize Rewards','winner@claim-big-prize-now.biz','You have won a new phone!!!','Claim your prize today before it expires.','Congratulation {{name}}!!!\n\nYou are selected to receive a brand new phone. Claim now before it expires.\n\nThis is limited today only.','', hintsPh,'junk'],
    ['Phishing / scam','phishing','Lloyds Security Team','lloydsverify@secure-update-mail.net','Urgent: your account will be suspended today','We noticed unusual activity. Verify your card now.','Dear customer,\n\nWe have seen suspicious login attemp on your banking. Your account will be suspended today unless you confirm your bank card detials now.\n\n[[Verify account now]]\n\nFailure to act may result in permanent lock.\n\nSecurity Team','fake-bank',hintsPh,'inbox'],
    ['Phishing / scam','phishing','Royal Mail','tracking@royalmail-deliveries-uk.com','Missed parcel delivery - action needed','A fee of £1.99 is required to rebook your parcel.','Hello,\n\nWe attempted to deliever your parcel today but nobody was home. To schedule redelivery, pay the small fee of £1.99 using the link below.\n\n[[Pay redelivery fee]]\n\nIf you do not act in 12 hours your parcel will be returned.','fake-delivery',hintsPh,'inbox'],
    ['Phishing / scam','phishing','HMRC Refund Team','refund-team@hmrc-taxreturns.help','You are owed a tax refund of £419.22','Complete the secure form now to receive your refund.','Dear Tax Payer,\n\nAfter the last annual calculation, you are due a refund of £419.22. Complete the online form now with your sort code, account number and card information for release of funds.\n\n[[Claim refund]]\n\nHMRC Department','fake-tax',hintsPh,'junk'],
    ['Phishing / scam','phishing','Microsoft Outlook','account-warning@outlook-verification-mail.com','Mailbox full - sign in now','Your mailbox storage is full and incoming emails will be blocked.','Attention {{name}},\n\nYour mailbox has exceeded storage limits. Sign in now to keep your email active and prevent message loss.\n\n[[Increase mailbox storage]]\n\nMicrosoft Mail Team','fake-email',hintsPh,'junk'],
    ['Phishing / scam','phishing','PayPal Service','security@paypal-verify-account-mail.com','Unauthorised payment detected','Confirm your login to reverse this payment now.','Hello {{name}},\n\nWe detected an unauthorised payment from your account. To reverse it, sign in using the secure form below now.\n\n[[Review payment]]\n\nFailure to act may result in permanent billing.','fake-paypal',hintsPh,'inbox']
  ];
  return raw.map(r=>({id:uid('tpl'),group:r[0],type:r[1],senderName:r[2],senderEmail:r[3],subject:r[4],preview:r[5],body:r[6],linkTarget:r[7],hints:r[8],defaultFolder:r[9]}));
}


function seedDemoMail(s, teacher, staff, students){
  const alex=students[0], mia=students[1], jordan=students[2];
  deliverTemplateToUser(s, s.templates.find(t=>t.subject==='Your parcel will arrive tomorrow'), alex.id, 'inbox');
  deliverTemplateToUser(s, s.templates.find(t=>t.subject==='Missed parcel delivery - action needed'), alex.id, 'inbox');
  deliverInternal(s, teacher.id, alex.id, 'Welcome to PLC Mail', 'Hello Alex,\n\nThis is your training mailbox. Use it to practise reading and replying to emails safely.\n\nTeacher Admin');
  deliverInternal(s, staff.id, alex.id, 'Travel training review reminder', 'Good morning Alex,\n\nThis is a reminder that your travel training review meeting is booked for Friday at 10:30.\n\nKind regards,\nSupport Team');
  deliverInternal(s, teacher.id, mia.id, 'Welcome to PLC Mail', 'Hello Mia,\n\nThis is your training mailbox. Please check your inbox each day and reply when needed.\n\nTeacher Admin');
  deliverTemplateToUser(s, s.templates.find(t=>t.subject==='Payslip available for March'), mia.id, 'inbox');
  deliverTemplateToUser(s, s.templates.find(t=>t.subject==='Mailbox full - sign in now'), jordan.id, 'junk');
}

function ensureStateShape(){
  state.templates = state.templates || buildTemplates();
  state.classes = state.classes || [];
  state.users = state.users || [];
  state.logins = state.logins || [];
  state.automations = state.automations || [];
  state.mailboxes = state.mailboxes || {};
  state.events = state.events || {};
  state.logins.forEach(l=>{
  if(!l.email){
    l.email = fullEmail(l.username || '');
  }
});
  state.meta = state.meta || {};
    state.users.forEach(u=>{
    const existingLogin = state.logins.find(l => l.userId === u.id);

    if(!existingLogin){
      state.logins.push({
        id: uid('login'),
        userId: u.id,
        role: u.role || 'student',
        username: u.username || '',
        password: u.password || (u.role === 'teacher' ? 'admin123' : u.role === 'staff' ? 'support123' : 'student123'),
        active: u.active !== false,
        displayName: u.displayName || '',
        classId: u.classId || ''
      });
    }
  });
  state.users.forEach(u=>{
    if(!state.mailboxes[u.id]) state.mailboxes[u.id]={inbox:[],junk:[],deleted:[],sent:[]};
    ['inbox','junk','deleted','sent'].forEach(f=>{ if(!Array.isArray(state.mailboxes[u.id][f])) state.mailboxes[u.id][f]=[]; });
    if(!state.events[u.id]) state.events[u.id]=[];
    if(typeof u.active === 'undefined') u.active = true;
    
  });
}
function clone(data){
  return JSON.parse(JSON.stringify(data));
}

async function loadInitialStateFromFirestore(){
  const snapshot = await getDoc(PLCMAIL_DOC);

  if(snapshot.exists()){
    state = snapshot.data();
    ensureStateShape();
    return state;
  }

  state = createInitialState();
  ensureStateShape();
  await setDoc(PLCMAIL_DOC, clone(state));
  return state;
}

function startFirestoreSync(){
  if(startedFirestoreSync) return;
  startedFirestoreSync = true;

  onSnapshot(PLCMAIL_DOC, (snapshot)=>{
    if(!snapshot.exists()) return;

    state = snapshot.data();
    ensureStateShape();

    if(currentUserId){
      if(isTeacherUser() || isStaffUser()){
        renderApp();
      } else {
        renderMailbox();
      }
    }
  }, (error)=>{
    console.error("Failed to start Firestore sync:", error);
  });
}

function resetDemo(){ state=createInitialState(); saveState(); }
async function login(username, password){
  const msg = document.getElementById('loginMsg');

  if(!state){
    setMessage(msg, 'warn', 'The app is still loading. Please try again.');
    return;
  }

  const safeUsername = String(username || '').trim().toLowerCase();
  const safePassword = String(password || '').trim();

  if(!safeUsername || !safePassword){
    setMessage(msg, 'warn', 'Enter your username and password.');
    return;
  }

 const loginRecord = (state.logins || []).find(item =>
  item.active !== false &&
  String(item.email || '').trim().toLowerCase() === safeUsername
);

  if(!loginRecord){
    setMessage(msg, 'warn', 'We could not find that email.');
    return;
  }

  if(String(loginRecord.password || '').trim() !== safePassword){
    setMessage(msg, 'warn', 'Incorrect password.');
    return;
  }

  currentUserId = loginRecord.userId;

  const existingIndex = state.users.findIndex(u => u.id === loginRecord.userId);
  const mergedUser = {
    id: loginRecord.userId,
    role: loginRecord.role || 'student',
    displayName: loginRecord.displayName || loginRecord.username,
    username: loginRecord.username || '',
    email: fullEmail(loginRecord.username || ''),
    password: loginRecord.password || '',
    classId: loginRecord.classId || '',
    active: loginRecord.active !== false,
    lastLogin: new Date().toLocaleString()
  };

  if(existingIndex >= 0) state.users[existingIndex] = mergedUser;
  else state.users.push(mergedUser);

  if(!state.mailboxes[currentUserId]){
    state.mailboxes[currentUserId] = { inbox:[], junk:[], deleted:[], sent:[] };
  }
  if(!state.events[currentUserId]){
    state.events[currentUserId] = [];
  }

  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  renderApp();
}
function logout(){
  currentUserId = null;
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginMsg').innerHTML = '';
}

function deliverInternal(s, senderId, recipientId, subject, body, folder='inbox', attachments=[]){
  const sender=s.users.find(u=>u.id===senderId); if(!sender) return;
  const mail={id:uid('mail'),senderId, senderName:sender.displayName, senderEmail:sender.email, recipientId, subject, preview:body.slice(0,90), body, folder, read:false, flagged:false, category: sender.role==='staff' ? 'internal':'safe', timeLabel:shortTime(), sentAt:timestamp(), linkTarget:'', linkLabel:'', hints:[{target:'from',label:'Check whether you recognise the sender'},{target:'body',label:'Check what action is being asked for'}], attachments, replies:[]};
  s.mailboxes[recipientId][folder].unshift(mail);
  const sentCopy=JSON.parse(JSON.stringify(mail)); sentCopy.id=uid('mail'); sentCopy.folder='sent'; sentCopy.read=true; s.mailboxes[senderId].sent.unshift(sentCopy);
}

function allowedRecipients(user){
  if(user.role==='teacher') return state.users.filter(u=>u.id!==user.id && u.active);
  if(user.role==='staff') return state.users.filter(u=>u.id!==user.id && u.active);
  const map=new Map();
  state.users.filter(u=>u.active && ['teacher','staff'].includes(u.role)).forEach(u=>map.set(u.id,u));
  if(state.settings?.allowStudentToStudent){
    state.users.filter(u=>u.active && u.role==='student' && u.id!==user.id).forEach(u=>map.set(u.id,u));
  }
  ['inbox','junk','deleted'].forEach(folder=>{
    state.mailboxes[user.id][folder].forEach(mail=>{
      if(mail.senderId){
        const sender=getUser(mail.senderId);
        if(sender && (sender.role!=='student' || state.settings?.allowStudentToStudent)) map.set(sender.id,sender);
      }
    });
  });
  return Array.from(map.values());
}
function isStudentMobile(){
  const u=currentUser();
  return !!u && u.role==='student' && window.innerWidth <= 768;
}

function mobileUnreadInboxCount(){
  return (state.mailboxes[currentUserId]?.inbox || []).filter(m=>!m.read).length;
}

function ensureMobileShell(){
  if(document.getElementById('mobileStudentBottomnav')) return;

  const shell=document.getElementById('appShell');
  shell.insertAdjacentHTML('beforeend', `
    <div id="mobileStudentOverlay" class="mobile-student-overlay hidden"></div>

    <aside id="mobileStudentDrawer" class="mobile-student-drawer hidden"></aside>

    <div id="mobileStudentBottomnav" class="mobile-student-bottomnav hidden">
      <button id="mobileMailTabBtn" class="mobile-nav-btn active">Mail <span id="mobileMailBadge" class="mobile-badge hidden">0</span></button>
      <button id="mobileCalendarTabBtn" class="mobile-nav-btn">Calendar</button>
    </div>
  `);

  document.getElementById('mobileStudentOverlay').onclick=closeMobileDrawer;
  document.getElementById('mobileMailTabBtn').onclick=()=>{
    mobileStudentTab='mail';
    mobileStudentView='list';
    mailFolder = mailFolder==='calendar' ? 'inbox' : mailFolder;
    renderMailbox();
  };
  document.getElementById('mobileCalendarTabBtn').onclick=()=>{
    mobileStudentTab='calendar';
    mobileStudentView='calendar';
    mailFolder='calendar';
    renderMailbox();
  };
}

function openMobileDrawer(){
  mobileDrawerOpen = true;
  renderMobileDrawer();
}

function closeMobileDrawer(){
  mobileDrawerOpen = false;
  renderMobileDrawer();
}

function renderMobileDrawer(){
  const drawer=document.getElementById('mobileStudentDrawer');
  const overlay=document.getElementById('mobileStudentOverlay');
  if(!drawer || !overlay || !isStudentMobile()) return;

  const user=currentUser();
  const counts=folderCounts(currentUserId);

  drawer.innerHTML=`
    <div class="mobile-drawer-head">
      <div class="mobile-drawer-user">
        <div class="mobile-drawer-avatar">${esc(initials(user.displayName))}</div>
        <div>
          <div style="font-weight:800">${esc(user.displayName)}</div>
          <div class="muted" style="font-size:13px">${esc(user.email)}</div>
        </div>
      </div>
    </div>

    <div class="mobile-drawer-list">
      <button class="mobile-drawer-btn ${mailFolder==='inbox'?'active':''}" data-mobile-folder="inbox"><span>Inbox</span><span class="count">${counts.inbox}</span></button>
      <button class="mobile-drawer-btn ${mailFolder==='junk'?'active':''}" data-mobile-folder="junk"><span>Junk</span><span class="count">${counts.junk}</span></button>
      <button class="mobile-drawer-btn ${mailFolder==='sent'?'active':''}" data-mobile-folder="sent"><span>Sent</span><span class="count">${counts.sent}</span></button>
      <button class="mobile-drawer-btn ${mailFolder==='deleted'?'active':''}" data-mobile-folder="deleted"><span>Deleted</span><span class="count">${counts.deleted}</span></button>
    </div>

    <div class="row" style="margin-top:18px">
      <button id="mobileSettingsBtn" class="mobile-gear-btn" aria-label="Settings">⚙</button>
      <button id="mobileChangePwBtn" class="btn-secondary">Change password</button>
      <button id="mobileLogoutBtn" class="btn-secondary">Log out</button>
    </div>
  `;

  drawer.classList.toggle('hidden', !mobileDrawerOpen);
  overlay.classList.toggle('hidden', !mobileDrawerOpen);

  drawer.querySelectorAll('[data-mobile-folder]').forEach(btn=>{
    btn.onclick=()=>{
      mailFolder=btn.dataset.mobileFolder;
      mobileStudentTab='mail';
      mobileStudentView='list';
      selectedMailId=null;
      composeMode=null;
      showHint=false;
      closeMobileDrawer();
      renderMailbox();
    };
  });

  document.getElementById('mobileSettingsBtn').onclick=()=>openChangePasswordModal();
  document.getElementById('mobileChangePwBtn').onclick=()=>openChangePasswordModal();
  document.getElementById('mobileLogoutBtn').onclick=logout;
}

function renderMobileStudentChrome(){
  ensureMobileShell();

  const bottom=document.getElementById('mobileStudentBottomnav');
  const badge=document.getElementById('mobileMailBadge');
  const mailBtn=document.getElementById('mobileMailTabBtn');
  const calBtn=document.getElementById('mobileCalendarTabBtn');
  const avatar=document.getElementById('avatar');
  const logout=document.getElementById('logoutBtn');
  const topChange=document.getElementById('topChangePw');
  const search=document.getElementById('globalSearch')?.closest('.search');
  const mailView=document.getElementById('mailView');

  bottom.classList.remove('hidden');

  if(avatar){
    avatar.style.cursor='pointer';
    avatar.onclick=openMobileDrawer;
  }

  if(logout) logout.classList.add('mobile-hidden');
  if(topChange) topChange.classList.add('mobile-hidden');
  if(search) search.classList.add('mobile-hidden');

  const unread=mobileUnreadInboxCount();
  badge.textContent=String(unread);
  badge.classList.toggle('hidden', unread===0);

  mailBtn.classList.toggle('active', mobileStudentTab==='mail');
  calBtn.classList.toggle('active', mobileStudentTab==='calendar');

  mailView.classList.remove('student-mobile-mail-list','student-mobile-mail-detail','student-mobile-calendar');

  if(mobileStudentTab==='calendar'){
    mailView.classList.add('student-mobile-calendar');
  } else if(mobileStudentView==='detail'){
    mailView.classList.add('student-mobile-mail-detail');
  } else {
    mailView.classList.add('student-mobile-mail-list');
  }

  renderMobileDrawer();
}

function clearMobileStudentChrome(){
  const bottom=document.getElementById('mobileStudentBottomnav');
  const drawer=document.getElementById('mobileStudentDrawer');
  const overlay=document.getElementById('mobileStudentOverlay');
  const avatar=document.getElementById('avatar');
  const logout=document.getElementById('logoutBtn');
  const topChange=document.getElementById('topChangePw');
  const search=document.getElementById('globalSearch')?.closest('.search');
  const mailView=document.getElementById('mailView');

  if(bottom) bottom.classList.add('hidden');
  if(drawer) drawer.classList.add('hidden');
  if(overlay) overlay.classList.add('hidden');

  if(avatar) avatar.onclick=null;
  if(logout) logout.classList.remove('mobile-hidden');
  if(topChange) topChange.classList.remove('mobile-hidden');
  if(search) search.classList.remove('mobile-hidden');

  if(mailView){
    mailView.classList.remove('student-mobile-mail-list','student-mobile-mail-detail','student-mobile-calendar');
  }

  mobileDrawerOpen=false;
}

function renderMobileBackBar(){
  if(!isStudentMobile() || mobileStudentTab==='calendar' || mobileStudentView!=='detail') return '';
  return `<div class="mobile-backbar"><button id="mobileBackToListBtn" class="btn-secondary">← Back</button><strong>${esc(folderLabel(mailFolder))}</strong></div>`;
}
function renderApp(){
  const user=currentUser();
  document.getElementById('avatar').textContent=initials(user.displayName);

  const brandSub = document.getElementById('brandSub');
  if(brandSub){
    brandSub.textContent =
      user.role==='teacher' ? 'Teacher admin view' :
      user.role==='staff' ? 'Staff tools' :
      (user.role.charAt(0).toUpperCase()+user.role.slice(1)+' mailbox');
  }

  document.getElementById('globalSearch').value='';
  searchTerm='';
  if(user.role==='teacher'){
    clearMobileStudentChrome();
    document.getElementById('adminView').classList.remove('hidden');
    document.getElementById('mailView').classList.add('hidden');
    renderAdmin();
  } else {
    document.getElementById('adminView').classList.add('hidden');
    document.getElementById('mailView').classList.remove('hidden');

    if(user.role==='staff'){
      clearMobileStudentChrome();

      if(!['inbox','junk','deleted','sent','templates','calendar'].includes(mailFolder)){
        mailFolder='inbox';
      }

      if(mailFolder==='templates'){
        selectedMailId=null;
      } else if(mailFolder!=='calendar' && !selectedMailId){
        selectedMailId=(state.mailboxes[currentUserId][mailFolder]||[])[0]?.id || null;
      }

      composeMode=null;
      showHint=false;
      renderMailbox();
    } else {
      if(isStudentMobile()){
        if(mobileStudentTab==='calendar'){
          mailFolder='calendar';
          mobileStudentView='calendar';
        } else {
          if(mailFolder==='calendar') mailFolder='inbox';
          mobileStudentTab='mail';
          if(!mobileStudentView || mobileStudentView==='calendar') mobileStudentView='list';
        }
      } else {
        clearMobileStudentChrome();
        mailFolder='inbox';
        selectedMailId=null;
        composeMode=null;
        showHint=false;
      }

      renderMailbox();
    }
  }
}
function staffCalendarPreviewUser(){
  if(!staffCalendarStudentId){
    const firstStudent = state.users.find(u=>u.role==='student' && u.active);
    staffCalendarStudentId = firstStudent ? firstStudent.id : '';
  }

  if(staffCalendarTargetMode === 'class'){
    const student = state.users.find(
      u => u.role==='student' && u.active && u.classId===staffCalendarTargetClassId
    );
    return student ? student.id : '';
  }

  return staffCalendarStudentId || '';
}

function renderStaffMailboxCalendarList(){
  const studentOptions = state.users.filter(u=>u.role==='student' && u.active);
  const classOptions = state.classes;

  if(!staffCalendarTargetClassId && classOptions[0]){
    staffCalendarTargetClassId = classOptions[0].id;
  }

  const anchor = getAnchorDate(staffCalendarAnchor || localDateKey(new Date()));
  const monthBase = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const monthLabel = formatMonthLabel(monthBase);
  const miniStart = startOfWeek(monthBase);
  const miniDays = [];

  for(let i=0;i<42;i++){
    const d = new Date(miniStart);
    d.setDate(miniStart.getDate()+i);
    miniDays.push(d);
  }

  const previewUserId = staffCalendarPreviewUser();

  return `
    <div class="student-calendar-side" style="padding:16px">
      <div class="row" style="margin-bottom:10px">
        <button class="chip-btn ${staffCalendarTargetMode==='class'?'active':''}" data-mailbox-calendar-target="class">Whole class</button>
        <button class="chip-btn ${staffCalendarTargetMode==='student'?'active':''}" data-mailbox-calendar-target="student">Selected student</button>
      </div>

      <div class="field">
        <label>Class</label>
        <select id="mailboxStaffCalendarClass">
          ${classOptions.map(c=>`<option value="${c.id}" ${c.id===staffCalendarTargetClassId?'selected':''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>

      <div class="field ${staffCalendarTargetMode==='student'?'':'hidden-inline'}" id="mailboxStaffStudentWrap">
        <label>Student</label>
        <select id="mailboxStaffCalendarStudent">
          ${studentOptions.map(u=>`<option value="${u.id}" ${u.id===staffCalendarStudentId?'selected':''}>${esc(u.displayName)} (${esc(className(u.classId))})</option>`).join('')}
        </select>
      </div>

      <div class="student-mini-month">
        <div class="student-mini-head">
          <button id="mailboxStaffPrevMonth" class="btn-secondary">◀</button>
          <strong>${esc(monthLabel)}</strong>
          <button id="mailboxStaffNextMonth" class="btn-secondary">▶</button>
        </div>

        <div class="student-mini-grid">
          ${['M','T','W','T','F','S','S'].map(h=>`<div class="head">${h}</div>`).join('')}
          ${miniDays.map(d=>`
            <button
              class="student-mini-date ${sameDate(d,anchor)?'is-selected':''} ${d.getMonth()!==monthBase.getMonth()?'is-muted':''} ${sameDate(d,getAnchorDate(localDateKey(new Date())))?'is-today':''}"
              data-mailbox-staff-anchor="${localDateKey(d)}"
            >
              ${d.getDate()}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="student-selected-box">
        <div style="font-weight:800;margin-bottom:6px">Selected date</div>
        <div class="muted">${esc(anchor.toLocaleDateString([], {weekday:'long', day:'numeric', month:'long', year:'numeric'}))}</div>
        <div style="margin-top:12px">
          ${previewUserId && eventsForUserOnDate(previewUserId, anchor).length
            ? eventsForUserOnDate(previewUserId, anchor).map(ev=>`
                <button class="student-event-chip" data-mailbox-staff-event="${ev.id}">
                  ${esc(ev.title)}
                  <small>${esc(ev.startTime||'All day')}${ev.endTime?` - ${esc(ev.endTime)}`:''}</small>
                </button>
              `).join('')
            : '<div class="muted">No events on this date.</div>'}
        </div>
      </div>
    </div>
  `;
}

function renderStaffMailboxCalendarReader(){
  const previewUserId = staffCalendarPreviewUser();

  if(!previewUserId){
    return `<div class="panel"><div class="muted">No students available for this selection.</div></div>`;
  }

  return `
    <div class="split" style="margin-bottom:14px">
      <div>
        <h2 style="margin:0">Day planner</h2>
        <div class="muted">Add and edit events for students and classes.</div>
      </div>
      <button id="mailboxStaffAddEventBtn" class="btn btn-primary">New event</button>
    </div>

    <div id="mailboxStaffCalendarRoot">
      ${renderCalendarForUser(previewUserId, 'day', staffCalendarAnchor, true)}
    </div>
  `;
}

function bindStaffMailboxCalendar(){
  const classSelect = document.getElementById('mailboxStaffCalendarClass');
  const studentSelect = document.getElementById('mailboxStaffCalendarStudent');

  document.querySelectorAll('[data-mailbox-calendar-target]').forEach(btn=>{
    btn.onclick = ()=>{
      staffCalendarTargetMode = btn.dataset.mailboxCalendarTarget;
      renderMailbox();
    };
  });

  if(classSelect){
    classSelect.onchange = ()=>{
      staffCalendarTargetClassId = classSelect.value;
      if(staffCalendarTargetMode === 'student'){
        const firstVisible = state.users.find(
          u => u.role==='student' && u.active && u.classId===staffCalendarTargetClassId
        );
        if(firstVisible) staffCalendarStudentId = firstVisible.id;
      }
      renderMailbox();
    };
  }

  if(studentSelect){
    studentSelect.onchange = ()=>{
      staffCalendarStudentId = studentSelect.value;
      renderMailbox();
    };
  }

  const prevBtn = document.getElementById('mailboxStaffPrevMonth');
  const nextBtn = document.getElementById('mailboxStaffNextMonth');

  if(prevBtn){
    prevBtn.onclick = ()=>{
      const d = getAnchorDate(staffCalendarAnchor || localDateKey(new Date()));
      d.setMonth(d.getMonth()-1);
      staffCalendarAnchor = localDateKey(d);
      renderMailbox();
    };
  }

  if(nextBtn){
    nextBtn.onclick = ()=>{
      const d = getAnchorDate(staffCalendarAnchor || localDateKey(new Date()));
      d.setMonth(d.getMonth()+1);
      staffCalendarAnchor = localDateKey(d);
      renderMailbox();
    };
  }

  document.querySelectorAll('[data-mailbox-staff-anchor]').forEach(btn=>{
    btn.onclick = ()=>{
      staffCalendarAnchor = btn.dataset.mailboxStaffAnchor;
      renderMailbox();
    };
  });

  document.querySelectorAll('[data-mailbox-staff-event]').forEach(btn=>{
    btn.onclick = ()=>{
      const previewUserId = staffCalendarPreviewUser();
      if(previewUserId){
        openCalendarEventEditor(previewUserId, btn.dataset.mailboxStaffEvent, staffCalendarTargetMode==='class' ? {classId:staffCalendarTargetClassId} : {});
      }
    };
  });
}

function bindStaffMailboxCalendarReader(){
  const previewUserId = staffCalendarPreviewUser();
  if(!previewUserId) return;

  const addBtn = document.getElementById('mailboxStaffAddEventBtn');
  if(addBtn){
    addBtn.onclick = ()=>{
      openCalendarEventEditor(
        previewUserId,
        '',
        staffCalendarTargetMode==='class' ? {classId:staffCalendarTargetClassId} : {}
      );
    };
  }

  document.querySelectorAll('#mailboxStaffCalendarRoot [data-event-id]').forEach(btn=>{
    btn.onclick = ()=>{
      openCalendarEventEditor(
        previewUserId,
        btn.dataset.eventId,
        staffCalendarTargetMode==='class' ? {classId:staffCalendarTargetClassId} : {}
      );
    };
  });

  document.querySelectorAll('#mailboxStaffCalendarRoot [data-staff-slot]').forEach(btn=>{
    btn.onclick = (e)=>{
      if(e.target.closest('[data-event-id]')) return;
      const parts = btn.dataset.staffSlot.split('|');
      openCalendarEventEditor(
        previewUserId,
        '',
        {
          ...(staffCalendarTargetMode==='class' ? {classId:staffCalendarTargetClassId} : {}),
          presetDate: parts[0],
          presetTime: parts[1]
        }
      );
    };
  });
}
function renderMailbox(){
  const counts=folderCounts(currentUserId);
  const user = currentUser();

document.querySelectorAll('[data-folder="templates"]').forEach(btn=>{
  btn.style.display = user.role === 'student' ? 'none' : '';
});
  ['inbox','junk','deleted','sent'].forEach(k=>{
    const el=document.getElementById('count-'+k);
    if(el) el.textContent=counts[k];
  });

  const isCalendar=mailFolder==='calendar';
  ['replyBtn','forwardBtn','deleteBtn','spamBtn','flagBtn','hintBtn','newMailBtn'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.style.display=isCalendar?'none':'';
  });

  renderMailList();
  renderMailReader();

  if(isStudentMobile()){
    renderMobileStudentChrome();

    const reader=document.querySelector('.mail-reader');
    if(reader){
      const oldBack=reader.querySelector('.mobile-backbar');
      if(oldBack) oldBack.remove();
      if(mobileStudentTab==='mail' && mobileStudentView==='detail'){
        reader.insertAdjacentHTML('afterbegin', renderMobileBackBar());
        const backBtn=document.getElementById('mobileBackToListBtn');
        if(backBtn) backBtn.onclick=()=>{
          mobileStudentView='list';
          renderMailbox();
        };
      }
    }
  } else {
    clearMobileStudentChrome();
  }
}
function renderAdmin(){ renderAdminSidebar(); renderAdminMain(); }
function templateGroupCounts(){ const m=new Map(); TEMPLATE_GROUPS.forEach(g=>m.set(g,0)); state.templates.forEach(t=>m.set(t.group,(m.get(t.group)||0)+1)); return Array.from(m.entries()).map(([group,count])=>({group,count})); }
function adminUsers(role){ return state.users.filter(u=>u.role===role); }
function groupTagClass(group){ return group==='Phishing / scam'?'phishing':group==='Spam / junk'?'spam':group==='Internal staff emails'?'internal':'safe'; }
function deleteUserPermanently(userId){
  state.users = state.users.filter(u=>u.id!==userId);
  delete state.mailboxes[userId];
  delete state.events[userId];
  state.automations = state.automations.map(auto=>({ ...auto, studentIds:(auto.studentIds||[]).filter(id=>id!==userId) })).filter(auto=>auto.kind==='custom' ? (auto.studentIds||[]).length : ((auto.studentIds||[]).length && (auto.kind==='custom' || auto.templateId)));
  state.activityLog = (state.activityLog||[]).filter(a=>a.userId!==userId);
  Object.values(state.mailboxes).forEach(box=>['inbox','junk','deleted','sent'].forEach(folder=>{ box[folder]=box[folder].filter(mail=>mail.senderId!==userId && mail.recipientId!==userId); }));
  if(selectedMailboxStudentId===userId) selectedMailboxStudentId='';
  saveState();
}
function peopleClassTabs(role){
  const counts = state.classes.map(c=>({id:c.id,name:c.name,count:state.users.filter(u=>u.role===role && u.classId===c.id).length}));
  if(role==='staff') return '';
  if(!studentManageClassId && counts[0]) studentManageClassId=counts[0].id;
  return '<div class="row">'+counts.map(c=>`<button class="chip-btn ${studentManageClassId===c.id?'active':''}" data-student-class-tab="${c.id}">${esc(c.name)} <span class="mini-note">${c.count}</span></button>`).join('')+'</div>';
}
function renderStudentsPage(main){
  const students=adminUsers('student');
  if(!studentManageClassId && state.classes[0]) studentManageClassId=state.classes[0].id;
  const filtered = studentManageClassId ? students.filter(u=>u.classId===studentManageClassId) : students;
  main.innerHTML=`<div class="stack"><div class="split"><div><h2 style="margin:0">Students</h2><p class="muted">Students are grouped by class tabs. Teachers can still see passwords and delete students permanently.</p></div><button id="addStudentBtn" class="btn btn-primary">Add student</button></div>${peopleClassTabs('student')}<div class="panel table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Password</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>${filtered.length?filtered.map(u=>`<tr><td>${esc(u.displayName)}</td><td>${esc(u.email)}</td><td>${esc(u.password)}</td><td>${u.active?'<span class="tag safe">Active</span>':'<span class="tag phishing">Inactive</span>'}</td><td>${esc(u.lastLogin||'Never')}</td><td><div class="row"><button class="mini-btn" data-edit-user="${u.id}">Edit</button><button class="mini-btn" data-open-box="${u.id}">Open mailbox</button><button class="btn-danger" data-delete-user="${u.id}">Delete student</button></div></td></tr>`).join(''):'<tr><td colspan="6" class="muted">No students in this class.</td></tr>'}</tbody></table></div></div>`;
  document.getElementById('addStudentBtn').onclick=()=>openUserModal('student');
  document.querySelectorAll('[data-student-class-tab]').forEach(b=>b.onclick=()=>{ studentManageClassId=b.dataset.studentClassTab; renderAdmin(); });
  document.querySelectorAll('[data-edit-user]').forEach(b=>b.onclick=()=>openUserModal('student',b.dataset.editUser));
  document.querySelectorAll('[data-open-box]').forEach(b=>b.onclick=()=>openMailboxReview(b.dataset.openBox));
  document.querySelectorAll('[data-delete-user]').forEach(b=>b.onclick=()=>confirmDeleteUser(b.dataset.deleteUser,'student'));
}
function selectedSendClassStudentRows(classId){
  const ids = classId ? classStudentIds(classId) : [];
  return ids.length ? ids.map(id=>{ const u=getUser(id); return `<label class="selector-item"><input type="checkbox" value="${u.id}"><div><div>${esc(u.displayName)}</div><small>${esc(u.email)}</small></div></label>`; }).join('') : '<div class="muted">Choose a class first.</div>';
}
function confirmDeleteUser(userId, roleLabel){
  const u=getUser(userId); if(!u) return;
  openModal(`<h2>Delete ${roleLabel}</h2><p>This will permanently remove <strong>${esc(u.displayName)}</strong> and all their mailbox data from local storage.</p><div class="row"><button id="confirmDeleteBtn" class="btn-danger">Delete permanently</button><button id="cancelDeleteBtn" class="btn-secondary">Cancel</button></div>`,'narrow');
  document.getElementById('cancelDeleteBtn').onclick=closeModal;
  document.getElementById('confirmDeleteBtn').onclick=()=>{ deleteUserPermanently(userId); closeModal(); renderAdmin(); };
}

function renderMailboxAdmin(main, students){
  const classCards = state.classes.map(c=>{
    const members = students.filter(u=>u.classId===c.id && u.active);
    return `<button class="panel class-card ${selectedMailboxClassId===c.id?'hinted':''}" data-mailbox-class="${c.id}"><div class="split"><h3 style="margin:0">${esc(c.name)}</h3><span class="pill">${members.length}</span></div><div class="muted">Click to view students in this class.</div></button>`;
  }).join('');
  const selectedStudents = selectedMailboxClassId ? students.filter(u=>u.classId===selectedMailboxClassId && u.active) : [];
  const selectedStudent = selectedMailboxStudentId ? getUser(selectedMailboxStudentId) : null;
  main.innerHTML=`<div class="stack"><div><h2 style="margin:0">Student Mailboxes</h2><p class="muted">Start with a class, then choose a student mailbox. This is designed to stay tidy for larger groups.</p></div>
    <div class="grid3">${classCards}</div>
    ${selectedMailboxClassId ? `<div class="panel"><div class="split"><h3 style="margin:0">${esc(className(selectedMailboxClassId))} students</h3><button id="clearMailboxView" class="btn-secondary">Clear selection</button></div><div class="selector-list" style="margin-top:14px">${selectedStudents.map(u=>`<button class="student-button" data-mailbox-student="${u.id}"><span>${esc(u.displayName)}<br><span class="mini-note">${esc(u.email)}</span></span><span class="pill">Open</span></button>`).join('') || '<div class="muted">No active students in this class.</div>'}</div></div>`:''}
    ${selectedStudent ? `<div class="panel"><div class="split"><div><h3 style="margin:0">${esc(selectedStudent.displayName)}</h3><div class="muted">${esc(selectedStudent.email)} • Password: <strong>${esc(selectedStudent.password)}</strong></div></div><button id="openMailboxModalBtn" class="btn btn-primary">Open mailbox</button></div><div class="mailbox-summary" style="margin-top:14px"><div class="soft-panel"><strong>${state.mailboxes[selectedStudent.id].inbox.length}</strong><div class="mini-note">Inbox</div></div><div class="soft-panel"><strong>${state.mailboxes[selectedStudent.id].junk.length}</strong><div class="mini-note">Junk</div></div><div class="soft-panel"><strong>${state.mailboxes[selectedStudent.id].deleted.length}</strong><div class="mini-note">Deleted</div></div></div></div>`:''}
  </div>`;
  document.querySelectorAll('[data-mailbox-class]').forEach(b=>b.onclick=()=>{ selectedMailboxClassId=b.dataset.mailboxClass; selectedMailboxStudentId=''; renderAdmin(); });
  document.querySelectorAll('[data-mailbox-student]').forEach(b=>b.onclick=()=>{ selectedMailboxStudentId=b.dataset.mailboxStudent; renderAdmin(); });
  const clear=document.getElementById('clearMailboxView'); if(clear) clear.onclick=()=>{ selectedMailboxClassId=''; selectedMailboxStudentId=''; renderAdmin(); };
  const open=document.getElementById('openMailboxModalBtn'); if(open) open.onclick=()=>openMailboxReview(selectedMailboxStudentId);
}

function openClassModal(classId=''){
  const existing=classId ? state.classes.find(c=>c.id===classId) : null;

  openModal(`<h2>${existing?'Rename class':'Add class'}</h2><div class="field"><label>Class name</label><input id="classNameInput" type="text" value="${esc(existing?.name||'')}" placeholder="Mint"></div><div class="row"><button id="saveClassBtn" class="btn btn-primary">${existing?'Save':'Create'}</button><button id="cancelClassBtn" class="btn-secondary">Cancel</button></div>`,'narrow');

  document.getElementById('cancelClassBtn').onclick=closeModal;

  document.getElementById('saveClassBtn').onclick=async ()=>{
    const name=document.getElementById('classNameInput').value.trim();
    if(!name) return;

    if(existing){
      existing.name=name;
    } else {
      state.classes.push({id:uid('class'),name});
    }

    await saveState();
    closeModal();
    renderAdmin();
  };
}

function openUserModal(defaultRole='student', userId=''){
  const existing=userId ? getUser(userId) : null;
  const role=existing ? existing.role : defaultRole;

  openModal(`<h2>${existing?'Edit user':'Add '+role}</h2><div class="grid2"><div class="field"><label>Display name</label><input id="uName" type="text" value="${esc(existing?.displayName||'')}" placeholder="Alex Carter"></div><div class="field"><label>Username</label><input id="uUsername" type="text" value="${esc(existing?.username||'')}" placeholder="alex.carter"></div><div class="field"><label>Password</label><input id="uPassword" type="text" value="${esc(existing?.password||'')}" placeholder="alex123"></div><div class="field"><label>Role</label><select id="uRole" ${existing?'disabled':''}><option value="student" ${role==='student'?'selected':''}>Student</option><option value="staff" ${role==='staff'?'selected':''}>Staff</option></select></div><div class="field"><label>Class</label><select id="uClass"><option value="">No class</option>${state.classes.map(c=>`<option value="${c.id}" ${existing?.classId===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Status</label><select id="uActive"><option value="true" ${(existing?.active ?? true)?'selected':''}>Active</option><option value="false" ${existing && !existing.active?'selected':''}>Inactive</option></select></div></div><div class="row"><button id="saveUserBtn" class="btn btn-primary">${existing?'Save changes':'Create user'}</button><button id="cancelUserBtn" class="btn-secondary">Cancel</button></div>`);

  document.getElementById('cancelUserBtn').onclick=closeModal;

  document.getElementById('saveUserBtn').onclick=async ()=>{
    const displayName=document.getElementById('uName').value.trim();
    const username=document.getElementById('uUsername').value.trim().replace(/\s+/g,'.').toLowerCase();
    const password=document.getElementById('uPassword').value.trim();
    const classId=document.getElementById('uClass').value;
    const active=document.getElementById('uActive').value==='true';
    const roleVal=existing ? existing.role : document.getElementById('uRole').value;

    if(!displayName || !username || !password) return;

    if(existing){
      existing.displayName=displayName;
      existing.username=username;
      existing.email=fullEmail(username);
      existing.password=password;
      existing.classId=classId;
      existing.active=active;
    } else {
      const u={
        id:uid('user'),
        role:roleVal,
        displayName,
        username,
        email:fullEmail(username),
        password,
        classId,
        active,
        lastLogin:''
      };
      state.users.push(u);
      state.logins.push({
  id:uid('login'),
  userId:u.id,
  role:roleVal,
  username,
  email: fullEmail(username),
  password,
  active,
  displayName,
  classId
});
      state.mailboxes[u.id]={inbox:[],junk:[],deleted:[],sent:[]};
      state.events[u.id]=[{day:'Mon',title:'Check-in',time:'10:00'}];
    }

    await saveState();
    closeModal();
    renderAdmin();
  };
}

function openTemplatePreview(templateId){
  const t=state.templates.find(x=>x.id===templateId); if(!t) return;
  openModal(`<h2>Template preview</h2><div class="stack"><div class="row"><span class="pill">${esc(t.group)}</span><span class="tag ${t.type}">${esc(t.type)}</span></div><div><strong>From:</strong> ${esc(t.senderName)} &lt;${esc(t.senderEmail)}&gt;</div><div><strong>Subject:</strong> ${esc(t.subject)}</div><div><strong>Preview text:</strong> ${esc(t.preview)}</div><div class="panel" style="padding:16px;white-space:pre-wrap">${esc(t.body)}</div><div class="row"><button id="editTplBtn" class="btn-secondary">Edit</button><button id="sendThisTemplateBtn" class="btn btn-primary">Send</button><button id="closeTplBtn" class="btn-secondary">Close</button></div></div>`,'compact');
  document.getElementById('closeTplBtn').onclick=closeModal;
  document.getElementById('sendThisTemplateBtn').onclick=()=>{ closeModal(); openTemplateSendModal(t.id); };
  document.getElementById('editTplBtn').onclick=()=>openTemplateEditModal(t.id);
}

function openTemplateEditModal(templateId){
  const t=state.templates.find(x=>x.id===templateId); if(!t) return;
  openModal(`<h2>Edit template</h2><div class="field"><label>Subject</label><input id="tplEditSubject" type="text" value="${esc(t.subject)}"></div><div class="field"><label>Preview text</label><input id="tplEditPreview" type="text" value="${esc(t.preview)}"></div><div class="field"><label>Body</label><textarea id="tplEditBody">${esc(t.body)}</textarea></div><div class="row"><button id="saveTplEditBtn" class="btn btn-primary">Save changes</button><button id="cancelTplEditBtn" class="btn-secondary">Cancel</button></div>`,'compact');
  document.getElementById('cancelTplEditBtn').onclick=closeModal;
  document.getElementById('saveTplEditBtn').onclick=()=>{
    t.subject=document.getElementById('tplEditSubject').value.trim() || t.subject;
    t.preview=document.getElementById('tplEditPreview').value.trim() || t.preview;
    t.body=document.getElementById('tplEditBody').value;
    saveState();
    closeModal();
    openTemplatePreview(templateId);
    if(adminSection==='library') renderAdmin();
  };
}

function classStudentIds(classId){ return state.users.filter(u=>u.role==='student' && u.active && u.classId===classId).map(u=>u.id); }

function openTemplateSendModal(initialTemplateId=''){
  const templateId = initialTemplateId || state.templates[0]?.id || '';

  openModal(`
    <div id="sendTplModalRoot">
      <h2>Send template</h2>

      <div class="field">
        <label>Template</label>
        <select id="sendTplTemplate">
          ${state.templates.map(t=>`
            <option value="${t.id}" ${t.id===templateId ? 'selected' : ''}>
              ${esc(t.group)} — ${esc(t.subject)}
            </option>
          `).join('')}
        </select>
      </div>

      <div class="grid2">
        <div>
          <div class="field">
            <label>Choose class</label>
            <select id="sendTplClass">
              <option value="">Choose a class</option>
              ${state.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select>
          </div>

          <div class="field">
            <label>Who should receive it?</label>
            <div class="row">
              <label class="selector-item" style="flex:1;align-items:flex-start">
                <input type="radio" name="sendMode" value="class" checked>
                <div style="text-align:left">
                  <div>Whole class</div>
                  <small>Send to all students in the selected class.</small>
                </div>
              </label>

              <label class="selector-item" style="flex:1;align-items:flex-start">
                <input type="radio" name="sendMode" value="selected">
                <div style="text-align:left">
                  <div>Selected students</div>
                  <small>Reveal the list only when needed.</small>
                </div>
              </label>
            </div>
          </div>

          <div id="sendTplStudentsWrap" class="field hidden">
            <label>Select students</label>
            <div id="sendTplStudents" class="selector-list"></div>
          </div>
        </div>

        <div>
          <div class="field">
            <label>Destination folder</label>
            <select id="sendTplFolder">
              <option value="inbox">Inbox</option>
              <option value="junk">Junk Email</option>
              <option value="deleted">Deleted Items</option>
            </select>
          </div>

          <div class="field">
            <label>Simulated attachment filenames</label>
            <input id="sendTplAttachments" type="text" placeholder="e.g. worksheet.pdf, poster.jpg">
          </div>

          <div class="soft-panel">
            <strong>Notes</strong>
            <div class="mini-note" style="margin-top:6px">
              This popup is kept deliberately smaller so the send button stays visible on laptop screens.
            </div>
          </div>
        </div>
      </div>

      <div class="row">
        <button id="sendTplSubmit" class="btn btn-primary">Send template</button>
        <button id="sendTplCancel" class="btn-secondary">Cancel</button>
      </div>

      <div id="sendTplMsg"></div>
    </div>
  `, 'compact');

  const root = document.getElementById('sendTplModalRoot');
  const classSelect = root.querySelector('#sendTplClass');
  const studentWrap = root.querySelector('#sendTplStudentsWrap');
  const studentList = root.querySelector('#sendTplStudents');
  const templateSelect = root.querySelector('#sendTplTemplate');
  const folderSelect = root.querySelector('#sendTplFolder');
  const attachmentsInput = root.querySelector('#sendTplAttachments');
  const msgBox = root.querySelector('#sendTplMsg');

  let recipientMode = 'class';

  function rebuildStudentList(){
    const ids = classSelect.value ? classStudentIds(classSelect.value) : [];

    if(!ids.length){
      studentList.innerHTML = '<div class="muted">Choose a class first.</div>';
      return;
    }

    studentList.innerHTML = ids.map(id=>{
      const u = getUser(id);
      return `
        <label style="
          display:flex;
          align-items:flex-start;
          justify-content:flex-start;
          gap:12px;
          width:100%;
          padding:12px 14px;
          border:1px solid var(--line);
          border-radius:14px;
          background:#fff;
          text-align:left;
          cursor:pointer;
        ">
          <input
            type="checkbox"
            value="${u.id}"
            style="margin:3px 0 0 0;flex:0 0 auto;width:16px;height:16px"
          >
          <div style="display:block;flex:1;min-width:0;text-align:left">
            <div style="font-weight:700">${esc(u.displayName)}</div>
            <small style="display:block;color:var(--muted);margin-top:2px">${esc(u.email)}</small>
          </div>
        </label>
      `;
    }).join('');
  }

  function setRecipientMode(mode){
    recipientMode = mode;
    studentWrap.classList.toggle('hidden', mode !== 'selected');
    if(mode === 'selected'){
      rebuildStudentList();
    }
  }

  root.querySelectorAll('input[name="sendMode"]').forEach(radio=>{
    radio.onclick = ()=>{
      setRecipientMode(radio.value);
    };
    radio.onchange = ()=>{
      setRecipientMode(radio.value);
    };
  });

  classSelect.onchange = ()=>{
    if(recipientMode === 'selected'){
      rebuildStudentList();
    }
  };

  setRecipientMode('class');

  root.querySelector('#sendTplCancel').onclick = closeModal;

  root.querySelector('#sendTplSubmit').onclick = ()=>{
    const classId = classSelect.value;
    const folder = folderSelect.value;
    const template = state.templates.find(t=>t.id === templateSelect.value);
    const attachments = parseAttachments(attachmentsInput.value);

    let ids = [];

    if(!classId){
      setMessage(msgBox, 'warn', 'Choose a class first.');
      return;
    }

      const checkedIds = Array.from(
      studentList.querySelectorAll('input[type="checkbox"]:checked')
    ).map(i=>i.value);

    const isSelectedMode = !studentWrap.classList.contains('hidden');

    if(isSelectedMode){
      ids = checkedIds;
    } else {
      ids = classStudentIds(classId);
    }

    if(!ids.length){
      setMessage(msgBox, 'warn', 'Choose at least one student.');
      return;
    }

    ids.forEach(id=>{
      deliverTemplateToUser(state, template, id, folder);
      if(attachments.length && state.mailboxes[id][folder] && state.mailboxes[id][folder][0]){
        state.mailboxes[id][folder][0].attachments = attachments;
      }
    });

    saveState();
    setMessage(msgBox, 'ok', 'Template sent successfully.');
  };
}

function openCustomComposeModal(){
  openModal(`<h2>Compose custom email</h2><div class="grid2"><div><div class="field"><label>From account</label><select id="customSender">${state.users.filter(u=>u.role==='teacher'||u.role==='staff').map(u=>`<option value="${u.id}">${esc(u.displayName)} (${esc(u.email)})</option>`).join('')}</select></div><div class="field"><label>Subject</label><input id="customSubject" type="text"></div><div class="field"><label>Message</label><textarea id="customBody"></textarea></div></div><div><div class="field"><label>Choose class</label><select id="customClass"><option value="">Choose a class</option>${state.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Students</label><div id="customStudents" class="selector-list"><div class="muted">Choose a class first.</div></div></div><div class="field"><label>Destination folder</label><select id="customFolder"><option value="inbox">Inbox</option><option value="junk">Junk Email</option><option value="deleted">Deleted Items</option></select></div><div class="field"><label>Attachment filenames</label><input id="customAttachments" type="text" placeholder="e.g. rota.docx, list.pdf"></div></div></div><div class="row"><button id="customSendBtn" class="btn btn-primary">Send email</button><button id="customCancelBtn" class="btn-secondary">Cancel</button></div><div id="customMsg"></div>`,'compact');
  const classSelect=document.getElementById('customClass');
  const studentList=document.getElementById('customStudents');
  function rebuild(){ const ids=classSelect.value ? classStudentIds(classSelect.value) : []; studentList.innerHTML = ids.length ? ids.map(id=>{ const u=getUser(id); return `<label class="selector-item"><input type="checkbox" value="${u.id}"><div><div>${esc(u.displayName)}</div><small>${esc(u.email)}</small></div></label>`; }).join('') : '<div class="muted">Choose a class first.</div>'; }
  classSelect.onchange=rebuild; rebuild();
  document.getElementById('customCancelBtn').onclick=closeModal;
  document.getElementById('customSendBtn').onclick=()=>{
    const senderId=document.getElementById('customSender').value;
    const subject=document.getElementById('customSubject').value.trim();
    const body=document.getElementById('customBody').value.trim();
    const folder=document.getElementById('customFolder').value;
    const ids=Array.from(studentList.querySelectorAll('input[type="checkbox"]:checked')).map(i=>i.value);
    const attachments=parseAttachments(document.getElementById('customAttachments').value);
    if(!subject || !body){ setMessage(document.getElementById('customMsg'),'warn','Enter a subject and message.'); return; }
    if(!ids.length){ setMessage(document.getElementById('customMsg'),'warn','Choose at least one student.'); return; }
    ids.forEach(id=>deliverInternal(state, senderId, id, subject, body, folder, attachments));
    saveState(); setMessage(document.getElementById('customMsg'),'ok','Custom email sent successfully.'); renderAdmin();
  };
}

function openAutomationModal(editId=''){
  const existing=editId ? state.automations.find(a=>a.id===editId) : null;
  openModal(`<h2>${existing?'Edit automation':'Add automation'}</h2>
    <div class="grid2">
      <div>
        <div class="field"><label>Automation name</label><input id="autoName" type="text" value="${esc(existing?.name||'')}"></div>
        <div class="field"><label>Template / source</label><select id="autoTemplate">${state.templates.map(t=>`<option value="${t.id}" ${existing?.templateId===t.id?'selected':''}>${esc(t.group)} — ${esc(t.subject)}</option>`).join('')}</select></div>
        <div class="field"><label>Frequency</label><select id="autoFrequency"><option value="Daily" ${existing?.frequency==='Daily'?'selected':''}>Daily</option><option value="Weekdays" ${existing?.frequency==='Weekdays'?'selected':''}>Weekdays</option><option value="Weekly" ${existing?.frequency==='Weekly'?'selected':''}>Weekly</option></select></div>
        <div class="field"><label>Quantity</label><input id="autoQuantity" type="number" min="1" value="${esc(existing?.quantity||1)}"></div>
        <div class="field"><label>Destination folder</label><select id="autoFolder"><option value="inbox" ${existing?.folder==='inbox'?'selected':''}>Inbox</option><option value="junk" ${existing?.folder==='junk'?'selected':''}>Junk Email</option><option value="deleted" ${existing?.folder==='deleted'?'selected':''}>Deleted Items</option></select></div>
      </div>
      <div>
        <div class="field"><label>Choose class</label><select id="autoClass"><option value="">Choose a class</option>${state.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Selected students</label><div class="row"><button id="autoShowStudentsBtn" type="button" class="btn-secondary">Select students</button><span class="mini-note" id="autoSelectedCount">${existing?.studentIds?.length || 0} selected</span></div></div>
        <div id="autoStudentsWrap" class="field hidden"><label>Student list</label><div id="autoStudents" class="selector-list"></div></div>
        <div class="soft-panel"><div class="mini-note">The student list only appears after you click <strong>Select students</strong>.</div></div>
      </div>
    </div>
    <div class="row"><button id="saveAutoBtn" class="btn btn-primary">${existing?'Save changes':'Save automation'}</button><button id="cancelAutoBtn" class="btn-secondary">Cancel</button></div>
    <div id="autoMsg"></div>`,'compact');

  const classSelect=document.getElementById('autoClass');
  const wrap=document.getElementById('autoStudentsWrap');
  const list=document.getElementById('autoStudents');
  const existingIds = new Set(existing?.studentIds || []);
function rebuildStudents(){
  const ids = classSelect.value ? classStudentIds(classSelect.value) : [];

  if(!ids.length){
    students.innerHTML = '<div class="muted">Choose a class first.</div>';
    return;
  }

  students.innerHTML = ids.map(id=>{
    const u = getUser(id);
    if(!u) return '';

    return `
      <label class="selector-item" style="display:flex;align-items:flex-start;justify-content:flex-start;gap:12px;width:100%;text-align:left;white-space:normal;padding:12px 14px">
        <input type="checkbox" value="${u.id}" style="margin:2px 0 0 0;flex:0 0 auto;width:16px;height:16px">
        <div style="display:block;flex:1;min-width:0;text-align:left">
          <div style="font-weight:700;line-height:1.3">${esc(u.displayName)}</div>
          <small style="display:block;color:var(--muted);margin-top:2px">${esc(u.email || fullEmail(u.username || ''))}</small>
        </div>
      </label>
    `;
  }).join('');
}
  document.getElementById('autoShowStudentsBtn').onclick=()=>{ wrap.classList.remove('hidden'); rebuildStudents(); };
  classSelect.onchange=()=>{ if(!wrap.classList.contains('hidden')) rebuildStudents(); };
  document.getElementById('cancelAutoBtn').onclick=closeModal;
document.getElementById('saveAutoBtn').onclick=async ()=>{
  const selectedIds = wrap.classList.contains('hidden') ? Array.from(existingIds) : Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(i=>i.value);
  if(!selectedIds.length){ setMessage(document.getElementById('autoMsg'),'warn','Choose at least one student.'); return; }

  const target = existing || {id:uid('auto'),active:true,lastRun:'',createdBy:currentUserId};
  target.kind='template';
  target.name=document.getElementById('autoName').value.trim() || 'Untitled automation';
  target.templateId=document.getElementById('autoTemplate').value;
  target.frequency=document.getElementById('autoFrequency').value;
  target.quantity=Math.max(1, Number(document.getElementById('autoQuantity').value||1));
  target.folder=document.getElementById('autoFolder').value;
  target.studentIds=selectedIds;

  if(!existing) state.automations.push(target);

  await saveState();
  closeModal();
  renderAdmin();
};
}

function openMailboxReview(userId){
  const user=getUser(userId);
  openModal(`<h2>${esc(user.displayName)} mailbox</h2><div class="grid3"><div class="stat"><div class="num">${state.mailboxes[userId].inbox.length}</div><div class="label">Inbox</div></div><div class="stat"><div class="num">${state.mailboxes[userId].junk.length}</div><div class="label">Junk</div></div><div class="stat"><div class="num">${state.mailboxes[userId].deleted.length}</div><div class="label">Deleted</div></div></div><div style="height:18px"></div><div class="panel table-wrap"><table><thead><tr><th>Folder</th><th>From</th><th>Subject</th><th>Time</th></tr></thead><tbody>${['inbox','junk','deleted','sent'].flatMap(folder=>state.mailboxes[userId][folder].slice(0,12).map(m=>`<tr><td>${folderLabel(folder)}</td><td>${esc(m.senderName)}</td><td>${esc(m.subject)}</td><td>${esc(m.sentAt)}</td></tr>`)).join('') || '<tr><td colspan="4" class="muted">No emails yet.</td></tr>'}</tbody></table></div><div class="row" style="margin-top:16px"><button id="closeReviewBtn" class="btn-secondary">Close</button></div>`, 'compact');
  document.getElementById('closeReviewBtn').onclick=closeModal;
}

function openChangePasswordModal(){
  const user=currentUser();
  openModal(`<h2>Change password</h2><div class="field"><label>Current password</label><input id="oldPw" type="password"></div><div class="field"><label>New password</label><input id="newPw" type="text"></div><div class="row"><button id="savePwBtn" class="btn btn-primary">Save password</button><button id="cancelPwBtn" class="btn-secondary">Cancel</button></div><div id="pwMsg"></div>`,'narrow');
  document.getElementById('cancelPwBtn').onclick=closeModal;
  document.getElementById('savePwBtn').onclick=()=>{
    if(document.getElementById('oldPw').value!==user.password){ setMessage(document.getElementById('pwMsg'),'warn','Current password is incorrect.'); return; }
    const np=document.getElementById('newPw').value.trim(); if(!np){ setMessage(document.getElementById('pwMsg'),'warn','Enter a new password.'); return; }
    user.password=np; saveState(); setMessage(document.getElementById('pwMsg'),'ok', user.role==='teacher' ? 'Password updated.' : 'Password updated. Teachers can still see student passwords in the admin area.'); if(user.role==='teacher') renderAdmin();
  };
}

function folderCounts(uid){ const box=state.mailboxes[uid]; return {inbox:box.inbox.length,junk:box.junk.length,deleted:box.deleted.length,sent:box.sent.length}; }
function currentMailItems(){ if(mailFolder==='calendar') return []; let items=state.mailboxes[currentUserId][mailFolder] || []; if(searchTerm.trim()){ const q=searchTerm.toLowerCase(); items=items.filter(m=>[m.senderName,m.senderEmail,m.subject,m.preview,m.body].join(' ').toLowerCase().includes(q)); } return items; }
function currentMail(){ return (state.mailboxes[currentUserId][mailFolder]||[]).find(m=>m.id===selectedMailId) || null; }



function bodyHtml(mail){ let safe=esc(mail.body); if(mail.linkTarget && mail.linkLabel){ safe=safe.replace('[['+mail.linkLabel+']]', `<span class="email-link" data-link="${mail.linkTarget}">${mail.linkLabel}</span>`); } return safe; }
function composeDirectory(user){
  const people = (user.role === 'student'
    ? allowedRecipients(user)
    : state.users.filter(u => u.active)
  ).map(u => ({
    type: 'user',
    id: u.id,
    label: `${u.displayName} (${u.email})`,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    classId: u.classId || ''
  }));

  const classes = user.role === 'student'
    ? []
    : state.classes.map(c => ({
        type: 'class',
        id: c.id,
        label: `${c.name} class`,
        className: c.name
      }));

  return [...classes, ...people];
}

function selectedComposeRecipients(which='to'){
  return which === 'cc' ? composeSelectedCc : composeSelectedTo;
}

function setSelectedComposeRecipients(which, list){
  if(which === 'cc') composeSelectedCc = list;
  else composeSelectedTo = list;
}

function composeRecipientTokensHtml(which='to'){
  const list = selectedComposeRecipients(which);
  if(!list.length) return '';
  return `<div class="compose-token-wrap">
    ${list.map(item => `
      <span class="compose-token">
        ${esc(item.label)}
        <button type="button" class="compose-token-x" data-remove-recipient="${which}|${item.key}">×</button>
      </span>
    `).join('')}
  </div>`;
}

function composeSuggestionItems(query, which='to'){
  const user = currentUser();
  const q = String(query || '').trim().toLowerCase();
  if(!q) return [];

  const directory = composeDirectory(user);
  return directory.filter(item => {
    if(item.type === 'class'){
      return item.className.toLowerCase().includes(q) || item.label.toLowerCase().includes(q);
    }
    return item.displayName.toLowerCase().includes(q) || item.email.toLowerCase().includes(q) || item.label.toLowerCase().includes(q);
  }).slice(0, 8);
}

function composeSuggestionsHtml(query, which='to'){
  const items = composeSuggestionItems(query, which);
  if(!items.length) return '';
  return `<div class="compose-suggestion-list">
    ${items.map(item => `
      <button type="button" class="compose-suggestion-item" data-add-recipient="${which}|${item.type}|${item.id}">
        <strong>${esc(item.type === 'class' ? item.className + ' class' : item.displayName)}</strong>
        <small>${esc(item.type === 'class' ? 'Add all students in this class' : item.email)}</small>
      </button>
    `).join('')}
  </div>`;
}

function addComposeRecipient(which, itemType, itemId){
  const user = currentUser();
  const current = selectedComposeRecipients(which).slice();

  if(itemType === 'class'){
    if(user.role === 'student') return;
    const cls = state.classes.find(c => c.id === itemId);
    if(!cls) return;

    const students = state.users
      .filter(u => u.active && u.role === 'student' && u.classId === cls.id)
      .map(u => ({
        key: `user:${u.id}`,
        type: 'user',
        id: u.id,
        label: `${u.displayName} (${u.email})`,
        email: u.email,
        displayName: u.displayName
      }));

    const merged = [...current];
    students.forEach(s => {
      if(!merged.some(x => x.key === s.key)) merged.push(s);
    });
    setSelectedComposeRecipients(which, merged);
    return;
  }

  const allowed = user.role === 'student'
    ? allowedRecipients(user)
    : state.users.filter(u => u.active);

  const target = allowed.find(u => u.id === itemId);
  if(!target) return;

  const entry = {
    key: `user:${target.id}`,
    type: 'user',
    id: target.id,
    label: `${target.displayName} (${target.email})`,
    email: target.email,
    displayName: target.displayName
  };

  if(!current.some(x => x.key === entry.key)) current.push(entry);
  setSelectedComposeRecipients(which, current);
}

function removeComposeRecipient(which, key){
  setSelectedComposeRecipients(which, selectedComposeRecipients(which).filter(x => x.key !== key));
}

function bindComposeAddressField(root=document){
  root.querySelectorAll('[data-remove-recipient]').forEach(btn => {
    btn.onclick = () => {
      const [which, key] = btn.dataset.removeRecipient.split('|');
      removeComposeRecipient(which, key);
      renderMailReader();
    };
  });

  root.querySelectorAll('[data-add-recipient]').forEach(btn => {
    btn.onclick = () => {
      const [which, type, id] = btn.dataset.addRecipient.split('|');
      addComposeRecipient(which, type, id);
      const input = document.getElementById(which === 'cc' ? 'msgCcSearch' : 'msgRecipientSearch');
      if(input) input.value = '';
      renderMailReader();
    };
  });

  const toInput = document.getElementById('msgRecipientSearch');
  if(toInput){
    toInput.oninput = () => {
      composeRecipientMode = 'to';
      const box = document.getElementById('msgToSuggestions');
      if(box) box.innerHTML = composeSuggestionsHtml(toInput.value, 'to');
      bindComposeAddressField(document);
    };
    toInput.onkeydown = (e) => {
      if(e.key === ' ' || e.key === 'Enter'){
        const items = composeSuggestionItems(toInput.value, 'to');
        if(items.length){
          e.preventDefault();
          addComposeRecipient('to', items[0].type, items[0].id);
          toInput.value = '';
          renderMailReader();
        }
      }
    };
  }

  const ccInput = document.getElementById('msgCcSearch');
  if(ccInput){
    ccInput.oninput = () => {
      composeRecipientMode = 'cc';
      const box = document.getElementById('msgCcSuggestions');
      if(box) box.innerHTML = composeSuggestionsHtml(ccInput.value, 'cc');
      bindComposeAddressField(document);
    };
    ccInput.onkeydown = (e) => {
      if(e.key === ' ' || e.key === 'Enter'){
        const items = composeSuggestionItems(ccInput.value, 'cc');
        if(items.length){
          e.preventDefault();
          addComposeRecipient('cc', items[0].type, items[0].id);
          ccInput.value = '';
          renderMailReader();
        }
      }
    };
  }
}
function renderComposeReply(mail){
  return `<div class="compose-box">
    <div class="split">
      <h3 style="margin:0">${composeMode==='new'?'New message':composeMode==='reply'?'Reply':'Forward message'}</h3>
      <button id="closeComposeBtn" class="btn-secondary">Close</button>
    </div>

    ${composeMode==='new' ? `
      <div class="field" style="margin-top:12px">
        <label>To</label>
        ${composeRecipientTokensHtml('to')}
        <input id="msgRecipientSearch" type="text" placeholder="Type a name, email or class">
        <div id="msgToSuggestions">${composeSuggestionsHtml('', 'to')}</div>
      </div>

      <div class="field">
        <label>CC</label>
        ${composeRecipientTokensHtml('cc')}
        <input id="msgCcSearch" type="text" placeholder="Type a name, email or class">
        <div id="msgCcSuggestions">${composeSuggestionsHtml('', 'cc')}</div>
      </div>

      <div class="field">
        <label>Subject</label>
        <input id="msgSubject" type="text" placeholder="Enter subject">
      </div>
    ` : `
      <div class="from-box" style="margin-top:12px">
        <strong>To:</strong> ${composeMode==='reply'
          ? `${esc(mail.senderName)} &lt;${esc(mail.senderEmail)}&gt;`
          : 'Choose recipients in a new message'}
      </div>
    `}

    <textarea id="msgText" placeholder="Type your message..."></textarea>

    <div class="field" style="margin-top:12px">
      <label>Add attachments</label>
      <input id="msgAttachments" type="file" multiple>
      <div class="mini-note">Choose files from this device, including photos and documents.</div>
    </div>

    <div id="msgAttachmentSummary" class="soft-panel" style="margin-top:10px">
      <div class="muted">No files selected yet.</div>
    </div>

    <div class="row" style="justify-content:space-between">
      <div class="muted">
        ${composeMode==='new'
          ? (currentUser().role==='student'
              ? 'Students can only email approved recipients.'
              : 'Search people or classes and add multiple recipients.')
          : 'Your sent message will appear below the email.'}
      </div>
      <button id="sendMsgBtn" class="btn btn-primary">Send</button>
    </div>

    <div id="composeReplyMsg"></div>
  </div>`;
}


function openMonitoredInboxModal(userId){
  const mailboxUsers = monitorableMailboxUsers();
  if(!mailboxUsers.length) return;
  monitoredMailboxUserId = mailboxUsers.some(u=>u.id===userId) ? userId : mailboxUsers[0].id;
  monitoredMailboxFolder = 'inbox';
  monitoredMailboxSelectedMailId = '';
  openModal('<div id="monitoredInboxRoot"></div>', 'default');
  renderMonitoredInboxModal();
}

function renderMonitoredInboxModal(){
  const root=document.getElementById('monitoredInboxRoot');
  if(!root) return;
  const mailboxUsers=monitorableMailboxUsers();
  if(!mailboxUsers.length){ root.innerHTML='<div class="panel">No staff inboxes available.</div>'; return; }
  const account = monitoredMailbox();
  if(!account){ monitoredMailboxUserId = mailboxUsers[0].id; }
  const user = monitoredMailbox();
  const folders=['inbox','junk','deleted','sent'];
  let items = (state.mailboxes[user.id]?.[monitoredMailboxFolder] || []).slice();
  if(!monitoredMailboxSelectedMailId || !items.some(m=>m.id===monitoredMailboxSelectedMailId)) monitoredMailboxSelectedMailId = items[0]?.id || '';
  const mail = items.find(m=>m.id===monitoredMailboxSelectedMailId) || null;
  root.innerHTML=`<div class="stack">
    <div class="split"><div><h2 style="margin:0">Open staff inbox</h2><p class="muted">Read student replies in teacher and staff mailboxes.</p></div><div class="row"><button id="monitoredCloseBtn" class="btn-secondary">Close</button></div></div>
    <div class="grid2">
      <div class="field"><label>Email account</label><select id="monitoredUserSelect">${mailboxUsers.map(u=>`<option value="${u.id}" ${u.id===user.id?'selected':''}>${esc(u.displayName)} (${esc(u.email)})</option>`).join('')}</select></div>
      <div class="soft-panel"><div style="font-weight:800">Currently viewing</div><div>${esc(user.displayName)}</div><div class="muted">${esc(user.email)}</div></div>
    </div>
    <div class="row">${folders.map(folder=>`<button class="folder-btn ${folder===monitoredMailboxFolder?'active':''}" data-mon-folder="${folder}" style="width:auto;border:1px solid var(--line)"><span class="folder-left"><span>${folder==='inbox'?'📥':folder==='junk'?'🛡️':folder==='deleted'?'🗑️':'📤'}</span><span>${folderLabel(folder)}</span></span><span class="count">${state.mailboxes[user.id][folder].length}</span></button>`).join('')}</div>
    <div class="grid2" style="align-items:start">
      <div class="panel" style="padding:0;overflow:hidden"><div class="mail-head"><div><h2>${esc(folderLabel(monitoredMailboxFolder))}</h2><p>${items.length} messages</p></div></div><div class="mail-list" style="max-height:52vh">${items.length ? items.map(m=>`<button class="mail-item ${m.id===monitoredMailboxSelectedMailId?'active':''}" data-mon-mail="${m.id}"><div class="mail-top"><div style="min-width:0"><div class="mail-from"><span class="truncate unread">${esc(m.senderName)}</span></div><div class="truncate read">${esc(m.subject)}</div></div><span class="time">${esc(m.timeLabel || '')}</span></div><div class="preview truncate">${esc(m.preview || '')}</div></button>`).join('') : '<div class="panel" style="margin:14px">No messages in this folder.</div>'}</div></div>
      <div class="panel">${mail ? `<div class="stack"><div class="split"><div><h3 style="margin:0">${esc(mail.subject)}</h3><div class="muted">${esc(mail.sentAt || '')}</div></div><span class="tag ${mail.category==='phishing'?'phishing':mail.category==='spam'?'spam':mail.category==='internal'?'internal':'safe'}">${esc(mail.category || 'safe')}</span></div><div class="from-box" style="margin-top:0"><strong>From:</strong> ${esc(mail.senderName)} &lt;${esc(mail.senderEmail)}&gt;</div><div class="from-box" style="margin-top:0"><strong>To:</strong> ${esc(user.email)}</div><div class="mail-body" style="margin-top:0">${bodyHtml(mail)}</div>${mail.attachments?.length?`<div class="attachment-wrap">${mail.attachments.map(a=>`<div class="attachment"><div><strong>${esc(a.filename)}</strong><div class="muted">${esc(a.filetype)} • ${esc(a.size)}</div></div></div>`).join('')}</div>`:''}${(mail.replies||[]).length?`<div class="stack">${mail.replies.map(r=>`<div class="reply-card"><div class="reply-head"><strong>${r.type==='reply'?'Student reply':'Message'}</strong><span>${esc(r.time)}</span></div><div style="white-space:pre-wrap;line-height:1.8">${esc(r.text)}</div></div>`).join('')}</div>`:''}</div>` : '<div class="muted">Select a message to read it.</div>'}</div>
    </div>
  </div>`;
  document.getElementById('monitoredCloseBtn').onclick=closeModal;
  document.getElementById('monitoredUserSelect').onchange=(e)=>{ monitoredMailboxUserId=e.target.value; monitoredMailboxFolder='inbox'; monitoredMailboxSelectedMailId=''; renderMonitoredInboxModal(); };
  root.querySelectorAll('[data-mon-folder]').forEach(b=>b.onclick=()=>{ monitoredMailboxFolder=b.dataset.monFolder; monitoredMailboxSelectedMailId=''; renderMonitoredInboxModal(); });
  root.querySelectorAll('[data-mon-mail]').forEach(b=>b.onclick=()=>{ monitoredMailboxSelectedMailId=b.dataset.monMail; renderMonitoredInboxModal(); });
}

async function sendCurrentMessage(){
  const user = currentUser();
  const text = document.getElementById('msgText').value.trim();
  const msg = document.getElementById('composeReplyMsg');

  let attachments = [];
  try{
    attachments = await collectRealAttachments('msgAttachments');
  }catch(err){
    setMessage(msg,'warn','One or more attachments could not be read.');
    return;
  }

  if(!text){
    setMessage(msg,'warn','Type a message first.');
    return;
  }

  if(composeMode==='new'){
    const subject = document.getElementById('msgSubject').value.trim();

    if(!composeSelectedTo.length){
      setMessage(msg,'warn','Add at least one recipient.');
      return;
    }

    if(!subject){
      setMessage(msg,'warn','Enter a subject.');
      return;
    }

    const toUsers = composeSelectedTo.filter(x => x.type === 'user');
    const ccUsers = composeSelectedCc.filter(x => x.type === 'user');
    const sentIds = new Set();

    [...toUsers, ...ccUsers].forEach(recipient => {
      if(sentIds.has(recipient.id)) return;
      sentIds.add(recipient.id);
      deliverInternal(state, user.id, recipient.id, subject, text, 'inbox', attachments);
    });

    if(user.role==='student'){
      toUsers.forEach(recipient => {
        const target = getUser(recipient.id);
        logActivity(
          target?.role==='student' ? 'student_peer_send' : 'student_send',
          user.id,
          'Sent an email to ' + (target?.displayName || recipient.label)
        );
      });
    }

    saveState();
    composeMode = null;
    composeSelectedTo = [];
    composeSelectedCc = [];
    mailFolder = 'sent';
    selectedMailId = state.mailboxes[user.id].sent[0]?.id || null;
    renderMailbox();
    return;
  }

  const mail = currentMail();

  if(composeMode==='reply'){
    if(mail.senderId){
      const sender = getUser(mail.senderId);

      if(user.role==='student' && sender && sender.role==='student' && !state.settings?.allowStudentToStudent){
        setMessage(msg,'warn','Students cannot reply to student accounts.');
        return;
      }

      deliverInternal(state, user.id, mail.senderId, 'Re: ' + mail.subject, text, 'inbox', attachments);
    }

    if(user.role==='student'){
      logActivity(
        mail.category==='phishing' ? 'reply_phishing' :
        mail.category==='spam' ? 'reply_spam' : 'student_send',
        user.id,
        mail.category==='phishing'
          ? 'Replied to a phishing email'
          : mail.category==='spam'
            ? 'Replied to a spam email'
            : 'Replied to ' + mail.senderName,
        mail.category==='phishing' ? 'high' : mail.category==='spam' ? 'medium' : 'info'
      );
    }

    mail.replies = mail.replies || [];
    mail.replies.push({type:'reply', text, time:shortTime()});
    saveState();
    composeMode = null;
    renderMailbox();
    return;
  }

  setMessage(msg,'warn','Forwarding is limited in this build. Use New message to send to users or classes.');
}
function moveMail(newFolder){ const mail=currentMail(); if(!mail) return; const box=state.mailboxes[currentUserId][mailFolder]; const idx=box.findIndex(m=>m.id===mail.id); if(idx<0) return; box.splice(idx,1); mail.folder=newFolder; state.mailboxes[currentUserId][newFolder].unshift(mail); selectedMailId=null; saveState(); renderMailbox(); }
function toggleFlag(){ const mail=currentMail(); if(!mail) return; mail.flagged=!mail.flagged; saveState(); renderMailbox(); }

function bindEvents(){
  document.getElementById('modalOverlay').addEventListener('click', e=>{ if(e.target.id==='modalOverlay') closeModal(); });
  document.getElementById('loginBtn').onclick=()=>login(document.getElementById('loginEmail').value, document.getElementById('loginPassword').value);
  const resetBtn = document.getElementById('resetDemoBtn');
if(resetBtn){
  resetBtn.onclick = () => {
    resetDemo();
    setMessage(document.getElementById('loginMsg'),'ok','Demo data reset...');
  };
}
  document.getElementById('logoutBtn').onclick=logout;
  document.getElementById('topChangePw').onclick=()=>openChangePasswordModal();

  document.getElementById('globalSearch').addEventListener('input', e=>{
    searchTerm=e.target.value;
    if(currentUser() && currentUser().role!=='teacher') renderMailbox();
  });

  document.querySelectorAll('.folder-btn').forEach(btn=>btn.onclick=()=>{
    mailFolder=btn.dataset.folder;
    selectedMailId=null;
    composeMode=null;
    showHint=false;

    if(isStudentMobile()){
      if(mailFolder==='calendar'){
        mobileStudentTab='calendar';
        mobileStudentView='calendar';
      } else {
        mobileStudentTab='mail';
        mobileStudentView='list';
      }
    }

    renderMailbox();
  });

  document.getElementById('replyBtn').onclick=()=>{
    if(mailFolder!=='calendar'){
      composeMode='reply';
      if(isStudentMobile()) mobileStudentView='detail';
      renderMailReader();
    }
  };

  document.getElementById('forwardBtn').onclick=()=>{
    if(mailFolder!=='calendar'){
      composeMode='forward';
      if(isStudentMobile()) mobileStudentView='detail';
      renderMailReader();
    }
  };

  document.getElementById('deleteBtn').onclick=()=>{ if(mailFolder!=='calendar' && mailFolder!=='deleted') moveMail('deleted'); };
  document.getElementById('spamBtn').onclick=()=>{ if(mailFolder!=='calendar' && mailFolder!=='junk') moveMail('junk'); };
  document.getElementById('flagBtn').onclick=()=>{ if(mailFolder!=='calendar') toggleFlag(); };
  document.getElementById('hintBtn').onclick=()=>{ if(mailFolder!=='calendar'){ showHint=!showHint; renderMailReader(); } };

document.getElementById('newMailBtn').onclick=()=>{
  composeMode='new';
  composeSelectedTo=[];
  composeSelectedCc=[];
  if(isStudentMobile()) mobileStudentView='detail';
  renderMailReader();
};

  window.addEventListener('resize', ()=>{
    if(!currentUser() || currentUser().role==='teacher') return;
    if(!isStudentMobile()){
      mobileStudentTab='mail';
      mobileStudentView='list';
      closeMobileDrawer();
    }
    renderMailbox();
  });
}



let dashboardClassTabId = '';
let staffTabMode = 'accounts';
let staffCalendarStudentId = '';
let staffCalendarView = 'month';
let staffCalendarAnchor = new Date().toISOString().slice(0,10);
let studentCalendarView = 'month';
let studentCalendarAnchor = new Date().toISOString().slice(0,10);
let staffInboxUserId = '';
let staffInboxFolder = 'inbox';
let staffInboxSelectedMailId = '';
let staffCalendarTargetMode = 'class';
let staffCalendarTargetClassId = '';
let mobileStudentTab = 'mail';
let mobileStudentView = 'list'; // list | detail | calendar
let mobileDrawerOpen = false;
function migrateState(){
  state.settings = state.settings || {allowStudentToStudent:false};
  state.activityLog = Array.isArray(state.activityLog) ? state.activityLog : [];
  state.templates = Array.isArray(state.templates) ? state.templates : buildTemplates();
  state.templates.forEach(t=>{
    if(!t.group || !TEMPLATE_GROUPS.includes(t.group)) t.group = 'Everyday safe emails';
    t.type = t.type || (t.group==='Phishing / scam' ? 'phishing' : t.group==='Spam / junk' ? 'spam' : t.group==='Internal staff emails' ? 'internal' : 'safe');
    t.preview = t.preview || '';
    t.body = t.body || '';
    t.senderName = t.senderName || 'Sender';
    t.senderEmail = t.senderEmail || 'sender@plcmail.com';
    t.defaultFolder = t.defaultFolder || 'inbox';
    t.linkTarget = t.linkTarget || '';
    t.hints = Array.isArray(t.hints) ? t.hints : [];
  });
  state.events = state.events || {};
  state.users.forEach(u=>{
    if(!state.mailboxes[u.id]) state.mailboxes[u.id] = {inbox:[], junk:[], deleted:[], sent:[]};
    if(!Array.isArray(state.events[u.id])) state.events[u.id] = [];
    if(state.events[u.id].some(ev => ev && !ev.date)) state.events[u.id] = [];
  });
  if(!dashboardClassTabId && state.classes[0]) dashboardClassTabId = state.classes[0].id;
  if(!staffCalendarStudentId){ const firstStudent = state.users.find(u=>u.role==='student' && u.active); staffCalendarStudentId = firstStudent ? firstStudent.id : ''; }
}
async function init(){
  await loadInitialStateFromFirestore();
  ensureStateShape();
  await saveState();
  startFirestoreSync();
  document.getElementById('loginEmail').value = '';
document.getElementById('loginPassword').value = '';

}

function createInitialState(){
  const mint=uid('class'), peach=uid('class'), amber=uid('class'), teal=uid('class'), sage=uid('class'), orange=uid('class');
  const teacher={id:uid('user'),role:'teacher',displayName:'Teacher Admin',username:'teacher',email:'teacher@plcmail.com',password:'admin123',classId:'',active:true,lastLogin:''};
  const staff={id:uid('user'),role:'staff',displayName:'Support Team',username:'support.team',email:'support.team@plcmail.com',password:'support123',classId:'',active:true,lastLogin:''};
  const students=[
    ['Alex Carter','alex.carter','alex123',mint],['Mia Robinson','mia.robinson','mia123',peach],['Jordan Smith','jordan.smith','jordan123',amber],
    ['Casey Jones','casey.jones','casey123',teal],['Taylor Green','taylor.green','taylor123',sage],['Sam Ahmed','sam.ahmed','sam123',orange]
  ].map(s=>({id:uid('user'),role:'student',displayName:s[0],username:s[1],email:fullEmail(s[1]),password:s[2],classId:s[3],active:true,lastLogin:''}));
  const users=[teacher,staff,...students];
    const logins = [
    {
      id: 'login-teacher',
      userId: teacher.id,
      role: 'teacher',
      username: 'teacher',
      password: 'admin123',
      active: true,
      displayName: 'Teacher Admin',
      classId: ''
    },
    {
      id: 'login-staff',
      userId: staff.id,
      role: 'staff',
      username: 'support.team',
      password: 'support123',
      active: true,
      displayName: 'Support Team',
      classId: ''
    },
    ...students.map(s => ({
      id: uid('login'),
      userId: s.id,
      role: 'student',
      username: s.username,
      password: s.password,
      active: true,
      displayName: s.displayName,
      classId: s.classId
    }))
  ];
  const classes=[{id:mint,name:'Mint'},{id:peach,name:'Peach'},{id:amber,name:'Amber'},{id:teal,name:'Teal'},{id:sage,name:'Sage'},{id:orange,name:'Orange'}];
  const s={ users, logins, classes, templates:buildTemplates(), automations:[], mailboxes:{}, events:{}, activityLog:[], settings:{allowStudentToStudent:false}, meta:{lastAutomationRun:''} };
  users.forEach(u=>{ s.mailboxes[u.id]={inbox:[],junk:[],deleted:[],sent:[]}; s.events[u.id]=[]; });
  seedDemoMail(s, teacher, staff, students);
  s.automations.push({id:uid('auto'), kind:'template', name:'Daily phishing practice',active:true,templateId:s.templates.find(t=>t.group==='Phishing / scam')?.id || '',frequency:'Daily',quantity:1,folder:'inbox',studentIds:[students[0].id,students[1].id],lastRun:'',createdBy:teacher.id});
  return s;
}

function logActivity(type, userId, detail, severity='info', meta={}){
  state.activityLog = Array.isArray(state.activityLog) ? state.activityLog : [];
  state.activityLog.unshift({id:uid('act'), type, userId, detail, severity, time:timestamp(), meta, read:false, cleared:false});
  state.activityLog = state.activityLog.slice(0,120);
}
function activityIcon(type){
  return type==='student_send'?'📤':type==='student_peer_send'?'👥':type==='reply_spam'?'⚠️':type==='reply_phishing'?'🚨':type==='phish_open'?'🔗':type==='phish_submit'?'🧾':'📝';
}
function classForUser(userId){ return getUser(userId)?.classId || ''; }
function classActivities(classId){ return (state.activityLog||[]).filter(a=>!a.cleared && classForUser(a.userId)===classId); }
function classActivityCount(classId){ return classActivities(classId).filter(a=>!a.read).length; }
function markActivityRead(activityId){ const item=(state.activityLog||[]).find(a=>a.id===activityId); if(item){ item.read=true; saveState(); } }
function clearActivity(activityId){ const item=(state.activityLog||[]).find(a=>a.id===activityId); if(item){ item.cleared=true; saveState(); } }
function clearClassActivities(classId){ (state.activityLog||[]).forEach(a=>{ if(classForUser(a.userId)===classId) a.cleared=true; }); saveState(); }

function recentStudentActivity(){ return (state.activityLog||[]).filter(a=>!a.cleared && getUser(a.userId)).slice(0,12); }


function staffInboxUsers(){ return state.users.filter(u=>u.active && ['teacher','staff'].includes(u.role)); }
function renderStaffInboxPage(){
  const mailboxUsers=staffInboxUsers();
  if(!staffInboxUserId || !mailboxUsers.some(u=>u.id===staffInboxUserId)) staffInboxUserId=mailboxUsers[0]?.id || '';
  const user=getUser(staffInboxUserId);
  if(!user) return '<div class="panel"><div class="muted">No staff inboxes available.</div></div>';
  const folders=['inbox','junk','deleted','sent'];
  const items=(state.mailboxes[user.id]?.[staffInboxFolder]||[]).slice();
  if(!staffInboxSelectedMailId || !items.some(m=>m.id===staffInboxSelectedMailId)) staffInboxSelectedMailId=items[0]?.id || '';
  const mail=items.find(m=>m.id===staffInboxSelectedMailId) || null;
  return `<div class="stack"><div class="split"><div><h3 style="margin:0">Staff inbox</h3><div class="muted">Open teacher and staff mailboxes on a full page.</div></div></div><div class="grid2"><div class="field"><label>Email account</label><select id="staffInboxSelect">${mailboxUsers.map(u=>`<option value="${u.id}" ${u.id===user.id?'selected':''}>${esc(u.displayName)} (${esc(u.email)})</option>`).join('')}</select></div><div class="soft-panel"><div style="font-weight:800">Currently viewing</div><div>${esc(user.displayName)}</div><div class="muted">Inbox ${state.mailboxes[user.id].inbox.length} • Junk ${state.mailboxes[user.id].junk.length} • Deleted ${state.mailboxes[user.id].deleted.length} • Sent ${state.mailboxes[user.id].sent.length}</div></div></div><div class="row">${folders.map(folder=>`<button class="folder-btn ${folder===staffInboxFolder?'active':''}" data-staff-folder="${folder}" style="width:auto;border:1px solid var(--line)"><span class="folder-left"><span>${folder==='inbox'?'📥':folder==='junk'?'🛡️':folder==='deleted'?'🗑️':'📤'}</span><span>${folderLabel(folder)}</span></span><span class="count">${state.mailboxes[user.id][folder].length}</span></button>`).join('')}</div><div class="grid2" style="align-items:start"><div class="panel" style="padding:0;overflow:hidden"><div class="mail-head"><div><h2>${esc(folderLabel(staffInboxFolder))}</h2><p>${items.length} messages</p></div></div><div class="mail-list" style="max-height:58vh">${items.length ? items.map(m=>`<button class="mail-item ${m.id===staffInboxSelectedMailId?'active':''}" data-staff-mail="${m.id}"><div class="mail-top"><div style="min-width:0"><div class="mail-from"><span class="truncate unread">${esc(m.senderName)}</span></div><div class="truncate read">${esc(m.subject)}</div></div><span class="time">${esc(m.timeLabel || '')}</span></div><div class="preview truncate">${esc(m.preview || '')}</div></button>`).join('') : '<div class="panel" style="margin:14px">No messages in this folder.</div>'}</div></div><div class="panel">${mail ? `<div class="stack"><div class="split"><div><h3 style="margin:0">${esc(mail.subject)}</h3><div class="muted">${esc(mail.sentAt || '')}</div></div><span class="tag ${mail.category==='phishing'?'phishing':mail.category==='spam'?'spam':mail.category==='internal'?'internal':'safe'}">${esc(mail.category || 'safe')}</span></div><div class="from-box" style="margin-top:0"><strong>From:</strong> ${esc(mail.senderName)} &lt;${esc(mail.senderEmail)}&gt;</div><div class="from-box" style="margin-top:0"><strong>To:</strong> ${esc(user.email)}</div><div class="mail-body" style="margin-top:0">${bodyHtml(mail)}</div>${(mail.replies||[]).length?`<div class="stack">${mail.replies.map(r=>`<div class="reply-card"><div class="reply-head"><strong>${r.type==='reply'?'Student reply':'Message'}</strong><span>${esc(r.time)}</span></div><div style="white-space:pre-wrap;line-height:1.8">${esc(r.text)}</div></div>`).join('')}</div>`:''}</div>` : '<div class="muted">Select a message to read it.</div>'}</div></div></div>`;
}
function bindStaffInboxPage(){
  const select=document.getElementById('staffInboxSelect'); if(select) select.onchange=(e)=>{ staffInboxUserId=e.target.value; staffInboxFolder='inbox'; staffInboxSelectedMailId=''; renderAdmin(); };
  document.querySelectorAll('[data-staff-folder]').forEach(b=>b.onclick=()=>{ staffInboxFolder=b.dataset.staffFolder; staffInboxSelectedMailId=''; renderAdmin(); });
  document.querySelectorAll('[data-staff-mail]').forEach(b=>b.onclick=()=>{ staffInboxSelectedMailId=b.dataset.staffMail; renderAdmin(); });
}

function renderStaffPage(main){
  const list=adminUsers('staff');
  if(!staffCalendarStudentId){ const firstStudent = state.users.find(u=>u.role==='student' && u.active); staffCalendarStudentId = firstStudent ? firstStudent.id : ''; }
  const studentOptions = state.users.filter(u=>u.role==='student' && u.active);
  const classOptions = state.classes;
  if(!staffCalendarTargetClassId && classOptions[0]) staffCalendarTargetClassId=classOptions[0].id;
  const calendarPanel = `<div class="panel"><div class="split"><div><h3 style="margin:0">Student calendar</h3><div class="muted">Month view is the default, with day and week views available when needed.</div></div><div class="row"><button id="calendarPrevBtn" class="btn-secondary">◀</button><button id="calendarTodayBtn" class="btn-secondary">Today</button><button id="calendarNextBtn" class="btn-secondary">▶</button><button id="calendarAddBtn" class="btn btn-primary">Add event</button></div></div><div class="grid2" style="margin-top:14px"><div class="stack"><div class="row"><button class="chip-btn ${staffCalendarTargetMode==='student'?'active':''}" data-calendar-target="student">Selected student</button><button class="chip-btn ${staffCalendarTargetMode==='class'?'active':''}" data-calendar-target="class">Whole class</button></div><div class="field" id="staffCalendarStudentWrap"><label>Student</label><select id="staffCalendarStudent">${studentOptions.map(u=>`<option value="${u.id}" ${u.id===staffCalendarStudentId?'selected':''}>${esc(u.displayName)} (${esc(className(u.classId))})</option>`).join('')}</select></div><div class="field ${staffCalendarTargetMode==='class'?'':'hidden-inline'}" id="staffCalendarClassWrap"><label>Class</label><select id="staffCalendarClass">${classOptions.map(c=>`<option value="${c.id}" ${c.id===staffCalendarTargetClassId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div></div><div class="row" style="justify-content:flex-end;align-self:end"><button class="chip-btn ${staffCalendarView==='day'?'active':''}" data-calendar-view="day">Day</button><button class="chip-btn ${staffCalendarView==='week'?'active':''}" data-calendar-view="week">Week</button><button class="chip-btn ${staffCalendarView==='month'?'active':''}" data-calendar-view="month">Month</button></div></div><div id="staffCalendarRoot" style="margin-top:14px"></div></div>`;
  const inboxPanel = renderStaffInboxPage();
  main.innerHTML=`<div class="stack"><div class="split"><div><h2 style="margin:0">Staff</h2><p class="muted">Manage staff accounts, inboxes, or student calendars.</p></div><button id="addStaffBtn" class="btn btn-primary">Add staff</button></div>
  <div class="row"><button class="chip-btn ${staffTabMode==='accounts'?'active':''}" data-staff-tab="accounts">Accounts</button><button class="chip-btn ${staffTabMode==='inbox'?'active':''}" data-staff-tab="inbox">Inbox</button><button class="chip-btn ${staffTabMode==='calendar'?'active':''}" data-staff-tab="calendar">Calendar</button></div>
  ${staffTabMode==='accounts' ? `<div class="panel table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Password</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>${list.map(u=>`<tr><td>${esc(u.displayName)}</td><td>${esc(u.email)}</td><td>${esc(u.password)}</td><td>${u.active?'<span class="tag safe">Active</span>':'<span class="tag phishing">Inactive</span>'}</td><td>${esc(u.lastLogin || 'Never')}</td><td><div class="row"><button class="mini-btn" data-edit-staff="${u.id}">Edit</button><button class="mini-btn" data-open-staff-page="${u.id}">Open inbox</button><button class="btn-danger" data-delete-staff="${u.id}">Delete staff</button></div></td></tr>`).join('')}</tbody></table></div>` : staffTabMode==='inbox' ? inboxPanel : calendarPanel}
  </div>`;
  document.getElementById('addStaffBtn').onclick=()=>openUserModal('staff');
  document.querySelectorAll('[data-staff-tab]').forEach(b=>b.onclick=()=>{ staffTabMode=b.dataset.staffTab; renderAdmin(); });
  document.querySelectorAll('[data-edit-staff]').forEach(b=>b.onclick=()=>openUserModal('staff',b.dataset.editStaff));
  document.querySelectorAll('[data-open-staff-page]').forEach(b=>b.onclick=()=>{ staffInboxUserId=b.dataset.openStaffPage; staffTabMode='inbox'; renderAdmin(); });
  document.querySelectorAll('[data-delete-staff]').forEach(b=>b.onclick=()=>confirmDeleteUser(b.dataset.deleteStaff,'staff'));
  if(staffTabMode==='calendar') bindStaffCalendarPage();
  if(staffTabMode==='inbox') bindStaffInboxPage();
}

function getAnchorDate(str){
  if(!str) return new Date();
  const parts=String(str).split('-').map(Number);
  if(parts.length===3 && parts.every(n=>!isNaN(n))){
    return new Date(parts[0], parts[1]-1, parts[2], 12, 0, 0, 0);
  }
  const d=new Date(str);
  return isNaN(d) ? new Date() : d;
}
function localDateKey(d){
  const year=d.getFullYear();
  const month=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return `${year}-${month}-${day}`;
}

function formatMonthLabel(d){ return d.toLocaleDateString([], {month:'long', year:'numeric'}); }
function sameDate(a,b){
  return a && b && localDateKey(a)===localDateKey(b);
}
function startOfWeek(d){ const c=new Date(d); const day=(c.getDay()+6)%7; c.setDate(c.getDate()-day); return c; }
function eventsForUserOnDate(userId, date){
  const key=localDateKey(date);
  const list=Array.isArray(state.events[userId]) ? state.events[userId] : [];

  function matches(ev){
    if(!ev) return false;
    if((ev.date||'')===key) return true;

    const repeat=ev.repeat||'none';
    const customDates=Array.isArray(ev.customDates) ? ev.customDates : [];
    if(customDates.includes(key)) return true;
    if(repeat==='none' || !ev.date) return false;

    const start=getAnchorDate(ev.date);
    const current=getAnchorDate(key);
    if(current < start) return false;

    if(repeat==='daily') return true;
    if(repeat==='weekly') return current.getDay()===start.getDay();
    if(repeat==='weekdays'){
      const day=current.getDay();
      return day>=1 && day<=5;
    }
    if(repeat==='monthly') return current.getDate()===start.getDate();

    return false;
  }

  return list
    .filter(matches)
    .sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||''));
}
function renderCalendarForUser(userId, view='day', anchorStr='', editable=false){
  const anchor=getAnchorDate(anchorStr || localDateKey(new Date()));

  if(view==='day'){
    const events=eventsForUserOnDate(userId, anchor);

    function hourNumber(timeStr){
      if(!timeStr) return null;
      const parts=String(timeStr).split(':');
      return Number(parts[0]) + (Number(parts[1]||0)/60);
    }

    let rows='';

    const allDay=events.filter(ev=>!ev.startTime);
    if(allDay.length){
      rows += `<div class="student-time-row">
        <div class="student-time-label">All day</div>
        <div class="student-slot">
          ${allDay.map(ev=>`
            <button class="student-event-chip ${editable?'calendar-event-open':''}" data-event-id="${ev.id}" ${!editable?`data-student-event="${ev.id}"`:''}>
              ${esc(ev.title)}
              <small>${ev.description?esc(ev.description):'No description'}</small>
            </button>
          `).join('')}
        </div>
      </div>`;
    }

    for(let h=6; h<=21; h++){
      const hh=String(h).padStart(2,'0');
      const label=new Date(`2000-01-01T${hh}:00:00`).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});

      const slotEvents=events.filter(ev=>{
        if(!ev.startTime) return false;
        const start=hourNumber(ev.startTime);
        const end=ev.endTime ? hourNumber(ev.endTime) : start + 1;
        return start !== null && end !== null && h >= Math.floor(start) && h < Math.ceil(end);
      });

      rows += `<div class="student-time-row">
        <div class="student-time-label">${esc(label)}</div>
        <div class="student-slot" ${editable?`data-staff-slot="${localDateKey(anchor)}|${hh}:00"`:`data-student-slot="${localDateKey(anchor)}|${hh}:00"`}>
          <div class="student-slot-note">Click to add an event</div>
          ${slotEvents.map(ev=>`
            <button class="student-event-chip ${editable?'calendar-event-open':''}" data-event-id="${ev.id}" ${!editable?`data-student-event="${ev.id}"`:''}>
              ${esc(ev.title)}
              <small>${esc(ev.startTime||'All day')}${ev.endTime?` - ${esc(ev.endTime)}`:''}</small>
            </button>
          `).join('')}
        </div>
      </div>`;
    }

    return `<div class="student-day-shell">
      <div class="student-day-scroll">
        <div class="student-day-header">
          <div>${esc(anchor.toLocaleDateString([], {weekday:'short'}))}</div>
          <div>${esc(anchor.toLocaleDateString([], {weekday:'long', day:'numeric', month:'long', year:'numeric'}))}</div>
        </div>
        ${rows}
      </div>
    </div>`;
  }

  const first=new Date(anchor.getFullYear(), anchor.getMonth(),1);
  const start=startOfWeek(first);
  const days=[];
  for(let i=0;i<42;i++){
    const d=new Date(start);
    d.setDate(start.getDate()+i);
    days.push(d);
  }

  return `<div class="calendar-month-board">
    ${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(h=>`<div class="calendar-month-head">${h}</div>`).join('')}
    ${days.map(d=>{
      const evs=eventsForUserOnDate(userId,d).slice(0,3);
      return `<div class="calendar-month-cell ${d.getMonth()!==anchor.getMonth()?'muted':''} ${sameDate(d,getAnchorDate(localDateKey(new Date())))?'today':''}">
        <button ${editable?`data-staff-date="${localDateKey(d)}"`:`data-student-anchor="${localDateKey(d)}"`} style="border:none;background:transparent;padding:0;text-align:left;cursor:pointer">
          <div class="calendar-month-day">${d.getDate()}</div>
        </button>
        ${evs.map(ev=>`<button class="calendar-month-event ${editable?'calendar-event-open':''}" data-event-id="${ev.id}">${esc(ev.startTime||'All day')} ${esc(ev.title)}</button>`).join('')}
        ${eventsForUserOnDate(userId,d).length>3?`<div class="mini-note">+${eventsForUserOnDate(userId,d).length-3} more</div>`:''}
      </div>`;
    }).join('')}
  </div>`;
}
function shiftCalendarAnchor(anchorStr, view, dir){
  const d=getAnchorDate(anchorStr || localDateKey(new Date()));
  if(view==='day') d.setDate(d.getDate()+dir);
  else if(view==='week') d.setDate(d.getDate()+7*dir);
  else d.setMonth(d.getMonth()+dir);
  return localDateKey(d);
}
function openStaffStudentPicker(){
  const studentOptions = state.users.filter(
    u => u.role === 'student' && u.active && (!staffCalendarTargetClassId || u.classId === staffCalendarTargetClassId)
  );

  openModal(
    `<h2>Select students</h2>
    <div class="field">
      <label>Students</label>
      <div class="selector-list" style="max-height:320px;overflow:auto">
        ${studentOptions.map(u => `
          <label class="selector-item" style="display:flex;align-items:center;justify-content:flex-start;gap:12px;padding:10px 12px;text-align:left;width:100%;white-space:nowrap">
            <input
              type="checkbox"
              class="staffStudentModalCheck"
              value="${u.id}"
              ${u.id === staffCalendarStudentId ? 'checked' : ''}
              style="margin:0;flex:0 0 auto;width:auto;min-width:16px;max-width:16px;height:16px"
            >
            <span style="display:inline-block;text-align:left;white-space:nowrap;flex:0 1 auto">
              ${esc(u.displayName)} <span class="mini-note">(${esc(className(u.classId))})</span>
            </span>
          </label>
        `).join('')}
      </div>
    </div>
    <div class="row">
      <button id="saveStudentPickerBtn" class="btn btn-primary">Use selected students</button>
      <button id="cancelStudentPickerBtn" class="btn-secondary">Cancel</button>
    </div>`,
    'narrow'
  );

  document.getElementById('cancelStudentPickerBtn').onclick = closeModal;

  document.getElementById('saveStudentPickerBtn').onclick = () => {
    const ids = Array.from(document.querySelectorAll('.staffStudentModalCheck:checked')).map(i => i.value);
    staffCalendarStudentId = ids[0] || '';
    closeModal();
    renderAdmin();
  };
}
function bindStaffCalendarPage(){
  const classSelect=document.getElementById('staffCalendarClass');
  const root=document.getElementById('staffCalendarRoot');

  function currentCalendarUser(){
    if(staffCalendarTargetMode==='class'){
      const student = state.users.find(u=>u.role==='student' && u.active && u.classId===staffCalendarTargetClassId);
      return student ? student.id : '';
    }
    return staffCalendarStudentId || '';
  }

  function currentOptions(){
    if(staffCalendarTargetMode==='class'){
      return {classId:staffCalendarTargetClassId};
    }
    return {};
  }

  function selectedTargetsForNewEvent(){
    if(staffCalendarTargetMode==='class'){
      return state.users.filter(u=>u.role==='student' && u.active && u.classId===staffCalendarTargetClassId).map(u=>u.id);
    }
    return staffCalendarStudentId ? [staffCalendarStudentId] : [];
  }

  function openEditorForTargets(eventId='', extraOptions={}){
    const ids = selectedTargetsForNewEvent();
    if(!ids.length) return;

    if(staffCalendarTargetMode==='class'){
      openCalendarEventEditor(ids[0], eventId, {...currentOptions(), ...extraOptions});
      return;
    }

    if(eventId){
      openCalendarEventEditor(ids[0], eventId, {...extraOptions});
      return;
    }

    ids.forEach(id=>{
      openCalendarEventEditor(id, '', {...extraOptions});
    });
  }

  function paint(){
    const uid=currentCalendarUser();
    if(!uid){
      root.innerHTML='<div class="muted">No students available for this selection.</div>';
      return;
    }

    root.innerHTML = renderCalendarForUser(uid, 'day', staffCalendarAnchor, true);

    root.querySelectorAll('[data-event-id]').forEach(b=>{
      b.onclick=()=>openCalendarEventEditor(uid, b.dataset.eventId, currentOptions());
    });

    root.querySelectorAll('[data-staff-slot]').forEach(b=>{
      b.onclick=(e)=>{
        if(e.target.closest('[data-event-id]')) return;
        const parts=b.dataset.staffSlot.split('|');
        openEditorForTargets('', {presetDate:parts[0], presetTime:parts[1]});
      };
    });

    document.querySelectorAll('[data-staff-anchor]').forEach(b=>{
      b.onclick=()=>{
        staffCalendarAnchor=b.dataset.staffAnchor;
        renderAdmin();
      };
    });

    document.querySelectorAll('.calendar-event-open').forEach(b=>{
      if(b.dataset.eventId){
        b.onclick=()=>openCalendarEventEditor(uid, b.dataset.eventId, currentOptions());
      }
    });
  }

  if(classSelect) classSelect.onchange=(e)=>{
    staffCalendarTargetClassId=e.target.value;
    if(staffCalendarTargetMode==='student'){
      const firstVisible = state.users.find(u=>u.role==='student' && u.active && u.classId===staffCalendarTargetClassId);
      staffCalendarStudentId = firstVisible ? firstVisible.id : '';
    }
    renderAdmin();
  };

  document.querySelectorAll('[data-calendar-target]').forEach(b=>{
    b.onclick=()=>{
      staffCalendarTargetMode=b.dataset.calendarTarget;
      renderAdmin();
    };
  });

  const pickerBtn=document.getElementById('openStudentPickerBtn');
  if(pickerBtn) pickerBtn.onclick=()=>openStaffStudentPicker();

  const addBtn=document.getElementById('calendarAddBtn');
  if(addBtn) addBtn.onclick=()=>{
    openEditorForTargets('');
  };

  paint();
}
function openCalendarEventEditor(userId, eventId='', options={}){
  const existing = eventId ? (state.events[userId]||[]).find(e=>e.id===eventId) : null;
  const targetClassId = options.classId || '';
  const targetClassName = targetClassId ? className(targetClassId) : '';
  const presetDate = options.presetDate || '';
  const presetTime = options.presetTime || '';

  openModal(`<h2>${existing?'Edit':'Add'} calendar event</h2>
    <div class="grid2">
      <div class="field"><label>Title</label><input id="eventTitle" type="text" value="${esc(existing?.title||'')}"></div>
      <div class="field"><label>Date</label><input id="eventDate" type="date" value="${esc(existing?.date||presetDate||localDateKey(new Date()))}"></div>
      <div class="field"><label>Start time</label><input id="eventStart" type="time" value="${esc(existing?.startTime||presetTime||'')}"></div>
      <div class="field"><label>End time</label><input id="eventEnd" type="time" value="${esc(existing?.endTime||'')}"></div>
      <div class="field"><label>Repeat</label><select id="eventRepeat">
        <option value="none" ${(existing?.repeat||'none')==='none'?'selected':''}>Does not repeat</option>
        <option value="daily" ${existing?.repeat==='daily'?'selected':''}>Every day</option>
        <option value="weekly" ${existing?.repeat==='weekly'?'selected':''}>Every week on this day</option>
        <option value="weekdays" ${existing?.repeat==='weekdays'?'selected':''}>Every weekday</option>
        <option value="monthly" ${existing?.repeat==='monthly'?'selected':''}>Every month on this date</option>
      </select></div>
      <div class="field"><label>Custom repeat dates</label><input id="eventCustomDates" type="text" value="${esc((existing?.customDates||[]).join(', '))}" placeholder="2026-04-18, 2026-04-25"></div>
    </div>
    ${targetClassId && !existing?`<div class="soft-panel" style="margin:12px 0">This event will be added to every student in <strong>${esc(targetClassName)}</strong>.</div>`:''}
    <div class="field"><label>Description</label><textarea id="eventDesc">${esc(existing?.description||'')}</textarea></div>
    <div class="row"><button id="saveEventBtn" class="btn btn-primary">Save event</button>${existing?'<button id="deleteEventBtn" class="btn-danger">Delete event</button>':''}<button id="cancelEventBtn" class="btn-secondary">Cancel</button></div>
    <div id="eventMsg"></div>`, 'compact');

  document.getElementById('cancelEventBtn').onclick=closeModal;

  document.getElementById('saveEventBtn').onclick=()=>{
    const title=document.getElementById('eventTitle').value.trim();
    const date=document.getElementById('eventDate').value;
    const startTime=document.getElementById('eventStart').value;
    const endTime=document.getElementById('eventEnd').value;
    const description=document.getElementById('eventDesc').value.trim();
    const repeat=document.getElementById('eventRepeat').value;
    const customDates=document.getElementById('eventCustomDates').value.split(',').map(s=>s.trim()).filter(Boolean);

    if(!title || !date){
      setMessage(document.getElementById('eventMsg'),'warn','Enter a title and date.');
      return;
    }

    if(targetClassId && !existing){
      const targetIds = state.users.filter(u=>u.role==='student' && u.active && u.classId===targetClassId).map(u=>u.id);
      targetIds.forEach(tid=>{
        state.events[tid]=Array.isArray(state.events[tid])?state.events[tid]:[];
        state.events[tid].push({
          id:uid('evt'),
          title,
          date,
          startTime,
          endTime,
          description,
          repeat,
          customDates
        });
      });
    } else {
      state.events[userId]=Array.isArray(state.events[userId])?state.events[userId]:[];
      const payload={
        id:existing?.id || uid('evt'),
        title,
        date,
        startTime,
        endTime,
        description,
        repeat,
        customDates
      };
      const idx=state.events[userId].findIndex(e=>e.id===payload.id);
      if(idx>=0) state.events[userId][idx]=payload;
      else state.events[userId].push(payload);
    }

    saveState();
    closeModal();
    renderAdmin();
  };

  const del=document.getElementById('deleteEventBtn');
  if(del) del.onclick=()=>{
    state.events[userId]=(state.events[userId]||[]).filter(e=>e.id!==eventId);
    saveState();
    closeModal();
    renderAdmin();
  };
}


function templateHintsForType(type){
  if(type==='phishing') return [{target:'from',label:'Check the sender email address'},{target:'body',label:'Look for urgency or requests for personal details'}];
  if(type==='spam') return [{target:'body',label:'Check whether the message feels professional'}];
  return [{target:'from',label:'Check whether you know the sender'},{target:'body',label:'Read the message carefully before replying'}];
}
function gatherTemplateEditorValues(){
  const type=document.getElementById('tplEditType').value;
  return { id:document.getElementById('sendPageTemplate').value || uid('tpl'), group:document.getElementById('sendPageGroup').value, type, senderName:document.getElementById('tplEditSenderName').value.trim() || 'Sender', senderEmail:document.getElementById('tplEditSenderEmail').value.trim() || 'sender@plcmail.com', subject:document.getElementById('tplEditSubject').value.trim() || 'Untitled template', preview:document.getElementById('tplEditPreview').value.trim(), body:document.getElementById('tplEditBody').value, defaultFolder:document.getElementById('sendPageFolder').value, linkTarget:document.getElementById('tplEditLinkTarget').value, hints:templateHintsForType(type) };
}
function processAutomations(force=false){
  const today=todayKey();
  state.automations.filter(a=>a.active).forEach(auto=>{
    if(!force && auto.lastRun===today) return;
    if(auto.frequency==='Weekdays' && weekdayNum()>5) return;
    if(auto.frequency==='Weekly' && weekdayNum()!==1 && !force) return;
    const studentIds=(auto.studentIds||[]).filter(id=>getUser(id));
    if(!studentIds.length) return;
    for(let i=0;i<Math.max(1, Number(auto.quantity||1));i++){
      if(auto.kind==='custom'){
        studentIds.forEach(studentId=>deliverInternal(state, auto.senderId, studentId, auto.subject, auto.body, auto.folder||'inbox', JSON.parse(JSON.stringify(auto.attachments||[]))));
      } else {
        const template = auto.templateSnapshot || state.templates.find(t=>t.id===auto.templateId);
        if(!template) return;
        studentIds.forEach(studentId=>deliverTemplateToUser(state, template, studentId, auto.folder||template.defaultFolder));
        if((auto.attachments||[]).length){ studentIds.forEach(studentId=>{ const latest=state.mailboxes[studentId][auto.folder||template.defaultFolder][0]; if(latest) latest.attachments=JSON.parse(JSON.stringify(auto.attachments)); }); }
      }
    }
    auto.lastRun=today;
  });
}
function getStudentPeerMessages(classId=''){
  const students = state.users.filter(u=>u.role==='student' && u.active && (!classId || u.classId===classId));
  const studentIds = new Set(students.map(u=>u.id));
  const all=[];
  students.forEach(u=>{
    (state.mailboxes[u.id]?.sent || []).forEach(mail=>{ const recipient = getUser(mail.recipientId); if(recipient && recipient.role==='student'){ all.push({sender:u, recipient, mail}); } });
  });
  return all.sort((a,b)=>new Date(b.mail.sentAt||0)-new Date(a.mail.sentAt||0));
}
function openStudentPeerMailboxModal(classId=''){
  if(classId) dashboardClassTabId = classId;
  openModal('<div id="peerMailboxRoot"></div>', 'default');
  renderStudentPeerMailboxModal();
}
function renderStudentPeerMailboxModal(){
  const root=document.getElementById('peerMailboxRoot'); if(!root) return;
  const classId = dashboardClassTabId || state.classes[0]?.id || '';
  const msgs = getStudentPeerMessages(classId);
  root.innerHTML=`<div class="stack"><div class="split"><div><h2 style="margin:0">Student to student email box</h2><p class="muted">Review emails students have sent to each other.</p></div><button id="peerCloseBtn" class="btn-secondary">Close</button></div><div class="row">${state.classes.map(c=>`<button class="chip-btn ${classId===c.id?'active':''}" data-peer-class="${c.id}">${esc(c.name)} <span class="badge-red">${getStudentPeerMessages(c.id).length}</span></button>`).join('')}</div><div class="panel table-wrap"><table><thead><tr><th>From</th><th>To</th><th>Subject</th><th>Time</th><th>Open</th></tr></thead><tbody>${msgs.length?msgs.map((entry,idx)=>`<tr><td>${esc(entry.sender.displayName)}</td><td>${esc(entry.recipient.displayName)}</td><td>${esc(entry.mail.subject)}</td><td>${esc(entry.mail.sentAt||'')}</td><td><button class="mini-btn" data-peer-open="${idx}">Read</button></td></tr>`).join(''):'<tr><td colspan="5" class="muted">No student-to-student emails in this class.</td></tr>'}</tbody></table></div></div>`;
  document.getElementById('peerCloseBtn').onclick=closeModal;
  root.querySelectorAll('[data-peer-class]').forEach(b=>b.onclick=()=>{ dashboardClassTabId=b.dataset.peerClass; renderStudentPeerMailboxModal(); });
  root.querySelectorAll('[data-peer-open]').forEach(b=>b.onclick=()=>{ const entry=msgs[Number(b.dataset.peerOpen)]; openModal(`<h2>${esc(entry.mail.subject)}</h2><div class="stack"><div class="soft-panel"><div><strong>From:</strong> ${esc(entry.sender.displayName)} (${esc(entry.sender.email)})</div><div><strong>To:</strong> ${esc(entry.recipient.displayName)} (${esc(entry.recipient.email)})</div><div class="muted">${esc(entry.mail.sentAt||'')}</div></div><div class="template-preview-box">${esc(entry.mail.body||'')}</div><div class="row"><button id="peerReadClose" class="btn-secondary">Close</button></div></div>`, 'compact'); document.getElementById('peerReadClose').onclick=closeModal; });
}
function openFakePage(type){ const cfg=fakePages[type]; if(!cfg) return; if(currentUser()?.role==='student') logActivity('phish_open', currentUserId, 'Opened a suspicious link: ' + cfg.title, 'high', {subject:cfg.title}); openModal(`<h2>${esc(cfg.title)}</h2><p>Enter your details below.</p>${cfg.fields.map((f,i)=>`<div class="field"><label>${esc(f)}</label><input type="${f.toLowerCase().includes('password')?'password':'text'}" data-fake="${i}" placeholder="${esc(f)}"></div>`).join('')}<div class="row"><button id="fakeSubmitBtn" class="btn btn-primary">Sign in</button><button id="fakeCloseBtn" class="btn-secondary">Close</button></div><div id="fakeMsg"></div>`, 'narrow'); document.getElementById('fakeCloseBtn').onclick=closeModal; document.getElementById('fakeSubmitBtn').onclick=()=>{ const entered=Array.from(document.querySelectorAll('[data-fake]')).some(i=>i.value.trim()); if(entered && currentUser()?.role==='student') logActivity('phish_submit', currentUserId, 'Entered details into a scam page: ' + cfg.title, 'high', {subject:cfg.title}); setMessage(document.getElementById('fakeMsg'),'warn', entered ? '<strong>This was a scam page.</strong><br>You should not enter personal or banking information into pages reached from suspicious emails. Check the sender address, spelling, urgency, and the web address before signing in.' : 'Even opening a suspicious page is a warning sign. Stop, close it, and check the email carefully before entering any details.'); } }



/* ===== v9 overrides ===== */

fakePages['fake-payment']={ title:'Secure Payment Page', fields:['Full name','Card number','Expiry date','Security code'] };
fakePages['fake-personal']={ title:'Personal Information Form', fields:['Full name','Date of birth','Address','Postcode'] };
function formatBytes(n){
  const num=Number(n||0);
  if(!num) return '0 KB';
  if(num<1024) return num+' B';
  if(num<1024*1024) return Math.round(num/102.4)/10+' KB';
  return Math.round(num/1024/102.4)/10+' MB';
}
async function fileToAttachment(file){
  const obj={id:uid('att'), filename:file.name, filetype:(file.name.split('.').pop()||file.type||'FILE').toUpperCase(), size:formatBytes(file.size), mimetype:file.type||'application/octet-stream'};
  if(file.size<=350000){
    obj.dataUrl = await new Promise((resolve)=>{ const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result||'')); reader.onerror=()=>resolve(''); reader.readAsDataURL(file); });
  }
  return obj;
}
async function collectFileAttachments(fileInputId, textInputId=''){
  const arr=[];
  if(textInputId){ arr.push(...parseAttachments(document.getElementById(textInputId)?.value||'')); }
  const input=document.getElementById(fileInputId);
  const files=Array.from(input?.files||[]);
  for(const file of files){ arr.push(await fileToAttachment(file)); }
  return arr;
}
function attachmentSummaryHtml(id){
  return `<div id="${id}" class="soft-panel"><div class="muted">No files selected yet.</div></div>`;
}
function bindAttachmentPicker(fileInputId, summaryId){
  const input=document.getElementById(fileInputId); const box=document.getElementById(summaryId); if(!input||!box) return;
  const render=()=>{
    const files=Array.from(input.files||[]);
    box.innerHTML = files.length ? files.map(f=>`<div class="split" style="padding:6px 0"><div><strong>${esc(f.name)}</strong></div><span class="mini-note">${formatBytes(f.size)}</span></div>`).join('') : '<div class="muted">No files selected yet.</div>';
  };
  input.onchange=render; render();
}


function bindFileSummary(fileInputId, summaryId){
  const input=document.getElementById(fileInputId);
  const box=document.getElementById(summaryId);
  if(!input || !box) return;

  const render=()=>{
    const files=Array.from(input.files || []);
    box.innerHTML = files.length
      ? files.map(f=>`
          <div class="split" style="padding:6px 0">
            <div><strong>${esc(f.name)}</strong></div>
            <span class="mini-note">${formatBytes(f.size)}</span>
          </div>
        `).join('')
      : '<div class="muted">No files selected yet.</div>';
  };

  input.onchange=render;
  render();
}



async function collectRealAttachments(inputId='msgAttachments'){
  const input=document.getElementById(inputId);
  if(!input || !input.files || !input.files.length) return [];

  const files=Array.from(input.files);
  const output=[];

  for(const file of files){
    const dataUrl = await fileToDataUrl(file);
    output.push({
      id: uid('att'),
      filename: file.name,
      filetype: (file.name.split('.').pop() || 'FILE').toUpperCase(),
      size: formatBytes(file.size),
      mimetype: file.type || 'application/octet-stream',
      dataUrl
    });
  }

  return output;
}
function cloneAttachments(list){ return JSON.parse(JSON.stringify(list||[])); }
function deliverTemplateToUser(s, tpl, userId, folderOverride=''){
  const user=s.users.find(u=>u.id===userId); if(!tpl||!user) return; const folder=folderOverride || tpl.defaultFolder || 'inbox';
  const labels={'fake-bank':'Verify account now','fake-delivery':'Pay redelivery fee','fake-tax':'Claim refund','fake-subscription':'Update payment','fake-email':'Increase mailbox storage','fake-paypal':'Review payment','fake-payment':'Pay now','fake-personal':'Open secure form'};
  const body=String(tpl.body||'').replaceAll('{{name}}', user.displayName).replaceAll('{{ref}}','REF-40321').replaceAll('{{address}}','24 Station Road');
  const mail={id:uid('mail'),senderId:null,senderName:tpl.senderName,senderEmail:tpl.senderEmail,recipientId:userId,subject:tpl.subject,preview:tpl.preview,body,folder,read:false,flagged:false,category:tpl.type,timeLabel:shortTime(),sentAt:timestamp(),linkTarget:tpl.linkTarget||'',linkLabel:labels[tpl.linkTarget]||tpl.linkLabel||'',hints:tpl.hints||[],attachments:cloneAttachments(tpl.attachments||[]),replies:[]};
  s.mailboxes[userId][folder].unshift(mail);
}
function openAttachment(mail, attId){
  const a=(mail.attachments||[]).find(x=>x.id===attId);
  if(!a) return;

  let preview='';
  let actions='<button id="closeAttBtn" class="btn-secondary">Close</button>';

  if(a.dataUrl && String(a.mimetype||'').startsWith('image/')){
    preview = `
      <div class="panel" style="padding:12px">
        <img src="${a.dataUrl}" alt="${esc(a.filename)}" style="max-width:100%;border-radius:14px">
      </div>
    `;
  }

  if(a.dataUrl){
    actions = `
      <button id="downloadAttBtn" class="btn btn-primary">Download</button>
      <button id="closeAttBtn" class="btn-secondary">Close</button>
    `;
  }

  openModal(`
    <h2>Attachment</h2>
    <div class="stack">
      <div class="panel">
        <strong>${esc(a.filename)}</strong>
        <div class="muted">${esc(a.filetype)} • ${esc(a.size)}</div>
      </div>
      ${preview || '<div class="message ok">This attachment is available inside the local prototype.</div>'}
      <div class="row">${actions}</div>
    </div>
  `,'compact');

  const close=document.getElementById('closeAttBtn');
  if(close) close.onclick=closeModal;

  const down=document.getElementById('downloadAttBtn');
  if(down){
    down.onclick=()=>{
      const link=document.createElement('a');
      link.href=a.dataUrl;
      link.download=a.filename || 'attachment';
      link.click();
    };
  }
}
function renderAdminSidebar(){
  const items=[['dashboard','Dashboard'],['classes','Classes'],['students','Students'],['staff','Staff'],['inbox','Inbox'],['calendar_admin','Calendar'],['send','Send Email'],['mailboxes','Student Mailboxes'],['settings','Settings']];
  document.getElementById('adminSidebar').innerHTML=items.map(i=>'<button class="nav-btn '+(adminSection===i[0]?'active':'')+'" data-admin="'+i[0]+'">'+i[1]+'</button>').join('');
  document.querySelectorAll('[data-admin]').forEach(b=>b.onclick=()=>{adminSection=b.dataset.admin; if(adminSection!=='send') sendEmailMode='menu'; renderAdmin();});
}
function renderAdminMain(){
  const main=document.getElementById('adminMain');
  const students=adminUsers('student'), staff=adminUsers('staff');
  if(adminSection==='dashboard'){ renderDashboardPage(main, students, staff); return; }
  if(adminSection==='classes'){
    main.innerHTML=`<div class="stack"><div class="split"><div><h2 style="margin:0">Classes</h2><p class="muted">Create and organise student groups.</p></div><button id="addClassBtn" class="btn btn-primary">Add class</button></div><div class="grid2">${state.classes.map(c=>`<div class="panel"><div class="split"><h3 style="margin:0">${esc(c.name)}</h3><button class="btn-secondary" data-edit-class="${c.id}">Rename</button></div><p class="muted">${students.filter(u=>u.classId===c.id).length} students</p><div class="stack">${students.filter(u=>u.classId===c.id).map(u=>`<div class="pill">${esc(u.displayName)}</div>`).join('') || '<div class="muted">No students assigned yet.</div>'}</div></div>`).join('')}</div></div>`;
    document.getElementById('addClassBtn').onclick=()=>openClassModal();
    document.querySelectorAll('[data-edit-class]').forEach(b=>b.onclick=()=>openClassModal(b.dataset.editClass));
    return;
  }
  if(adminSection==='students'){ renderStudentsPage(main); return; }
  if(adminSection==='staff'){ renderStaffAccountsPage(main); return; }
  if(adminSection==='inbox'){ renderInboxAdminPage(main); return; }
  if(adminSection==='calendar_admin'){ renderCalendarAdminPage(main); return; }
  if(adminSection==='send'){ renderSendPage(main); return; }
  if(adminSection==='mailboxes'){ renderMailboxAdmin(main, students); return; }
  if(adminSection==='settings'){
    main.innerHTML=`<div class="stack"><div><h2 style="margin:0">Settings</h2><p class="muted">Local testing controls.</p></div><div class="grid2"><div class="panel"><h3 style="margin-top:0">Teacher account</h3><p class="muted">Email: teacher@plcmail.com</p><button id="teacherPwBtn" class="btn btn-primary">Change teacher password</button></div><div class="panel"><h3 style="margin-top:0">Student to student emailing</h3><p class="muted">Turn this on only during lessons.</p><label class="selector-item"><input id="settingsPeerToggle" type="checkbox" ${state.settings?.allowStudentToStudent?'checked':''}><div><div>Allow student to student emails</div><small>${state.settings?.allowStudentToStudent?'Students can currently email each other.':'Students can only email staff, teachers, and approved senders.'}</small></div></label></div><div class="panel"><h3 style="margin-top:0">Reset local data</h3><p class="muted">Clear all classes, users, mailboxes, and automations and return to the demo setup.</p><button id="fullResetBtn" class="btn-danger">Reset demo data</button></div></div></div>`;
    document.getElementById('teacherPwBtn').onclick=()=>openChangePasswordModal();
    document.getElementById('settingsPeerToggle').onchange=(e)=>{ state.settings.allowStudentToStudent=e.target.checked; saveState(); renderAdmin(); };
    document.getElementById('fullResetBtn').onclick=()=>{ resetDemo(); renderApp(); };
  }
}
function renderStaffAccountsPage(main){
  const list=adminUsers('staff');
  main.innerHTML=`<div class="stack"><div class="split"><div><h2 style="margin:0">Staff</h2><p class="muted">Manage staff accounts only. Use the separate Inbox and Calendar tabs for mailbox and calendar tools.</p></div><button id="addStaffBtn" class="btn btn-primary">Add staff</button></div><div class="panel table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Password</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>${list.map(u=>`<tr><td>${esc(u.displayName)}</td><td>${esc(u.email)}</td><td>${esc(u.password)}</td><td>${u.active?'<span class="tag safe">Active</span>':'<span class="tag phishing">Inactive</span>'}</td><td>${esc(u.lastLogin || 'Never')}</td><td><div class="row"><button class="mini-btn" data-edit-staff="${u.id}">Edit</button><button class="btn-danger" data-delete-staff="${u.id}">Delete staff</button></div></td></tr>`).join('')}</tbody></table></div></div>`;
  document.getElementById('addStaffBtn').onclick=()=>openUserModal('staff');
  document.querySelectorAll('[data-edit-staff]').forEach(b=>b.onclick=()=>openUserModal('staff',b.dataset.editStaff));
  document.querySelectorAll('[data-delete-staff]').forEach(b=>b.onclick=()=>confirmDeleteUser(b.dataset.deleteStaff,'staff'));
}
function renderInboxAdminPage(main){
  main.innerHTML=`<div class="stack"><div class="split"><div><h2 style="margin:0">Inbox</h2><p class="muted">Switch between teacher and staff mailboxes from one full page.</p></div></div>${renderStaffInboxPage()}</div>`;
  bindStaffInboxPage();
}
function renderCalendarAdminPage(main){
  if(!staffCalendarStudentId){
    const firstStudent = state.users.find(u=>u.role==='student' && u.active);
    staffCalendarStudentId = firstStudent ? firstStudent.id : '';
  }

  const studentOptions = state.users.filter(u=>u.role==='student' && u.active);
  const classOptions = state.classes;
  if(!staffCalendarTargetClassId && classOptions[0]) staffCalendarTargetClassId=classOptions[0].id;

  const anchor=getAnchorDate(staffCalendarAnchor || localDateKey(new Date()));
  const monthLabel=formatMonthLabel(anchor);
  const miniStart=startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const miniDays=[];
  for(let i=0;i<42;i++){
    const d=new Date(miniStart);
    d.setDate(miniStart.getDate()+i);
    miniDays.push(d);
  }

  function currentCalendarUserPreview(){
    if(staffCalendarTargetMode==='class'){
      const student = state.users.find(u=>u.role==='student' && u.active && u.classId===staffCalendarTargetClassId);
      return student ? student.id : '';
    }
    return staffCalendarStudentId || '';
  }

  const previewUserId=currentCalendarUserPreview();
  const selectedCount = Array.from(studentOptions).filter(u=>u.id===staffCalendarStudentId).length || (staffCalendarStudentId ? 1 : 0);

  main.innerHTML=`<div class="stack">
    <div class="split">
      <div>
        <h2 style="margin:0">Calendar</h2>
        <p class="muted">Create events for a selected student or a whole class.</p>
      </div>
      <div class="row">
        <button id="calendarAddBtn" class="btn btn-primary">New event</button>
      </div>
    </div>

    <div class="row">
      <button class="chip-btn ${staffCalendarTargetMode==='class'?'active':''}" data-calendar-target="class">Whole class</button>
      <button class="chip-btn ${staffCalendarTargetMode==='student'?'active':''}" data-calendar-target="student">Selected student</button>
    </div>

    <div class="field ${staffCalendarTargetMode==='class'?'':'hidden-inline'}" id="staffCalendarClassWrap" style="max-width:420px">
      <label>Class</label>
      <select id="staffCalendarClass">
        ${classOptions.map(c=>`<option value="${c.id}" ${c.id===staffCalendarTargetClassId?'selected':''}>${esc(c.name)}</option>`).join('')}
      </select>
    </div>

    <div class="field ${staffCalendarTargetMode==='student'?'':'hidden-inline'}" id="staffCalendarStudentWrap" style="max-width:420px">
      <label>Select students</label>
      <div class="row">
        <button id="openStudentPickerBtn" class="btn-secondary" type="button">Choose students</button>
        <span class="mini-note" id="selectedStudentCountLabel">${selectedCount} selected</span>
      </div>
    </div>

    <div class="calendar-mini-layout">
      <div class="calendar-mini-sidebar">
        <div class="calendar-mini-card">
          <div class="split" style="margin-bottom:10px">
            <strong>${esc(monthLabel)}</strong>
            <span class="mini-note">Select a date</span>
          </div>
          <div class="calendar-mini-grid">
            ${['M','T','W','T','F','S','S'].map(h=>`<div class="head">${h}</div>`).join('')}
            ${miniDays.map(d=>`<button class="${sameDate(d,anchor)?'selected':''}" data-staff-anchor="${localDateKey(d)}" style="border:none;background:${sameDate(d,anchor)?'#2563eb':'transparent'};color:${sameDate(d,anchor)?'#fff':'inherit'};padding:6px 0;border-radius:10px;cursor:pointer">${d.getDate()}</button>`).join('')}
          </div>
        </div>

        <div class="calendar-mini-card">
          <div style="font-weight:800;margin-bottom:6px">Selected date</div>
          <div class="muted">${anchor.toLocaleDateString([], {weekday:'long', day:'numeric', month:'long', year:'numeric'})}</div>
          <div style="margin-top:12px">
            ${previewUserId && eventsForUserOnDate(previewUserId, anchor).length
              ? eventsForUserOnDate(previewUserId, anchor).map(ev=>`<button class="calendar-month-event calendar-event-open" data-event-id="${ev.id}">${esc(ev.startTime||'All day')} ${esc(ev.title)}</button>`).join('')
              : '<div class="muted">No events on this date.</div>'}
          </div>
        </div>
      </div>

      <div class="calendar-main">
        <div id="staffCalendarRoot">${previewUserId ? renderCalendarForUser(previewUserId, 'day', staffCalendarAnchor, true) : '<div class="muted">No students available for this selection.</div>'}</div>
      </div>
    </div>
  </div>`;

  bindStaffCalendarPage();
}
function monitorOpenForActivity(activity){ const meta = activity.meta || {}; if(meta.mailboxUserId){ adminSection='inbox'; staffInboxUserId=meta.mailboxUserId; renderAdmin(); } }
function openActivityDetails(activityId){
  const activity = (state.activityLog||[]).find(a=>a.id===activityId); if(!activity) return; activity.read=true; saveState();
  const user = getUser(activity.userId); const meta = activity.meta || {};
  openModal(`<h2>Student interaction</h2><div class="stack"><div class="soft-panel"><strong>${esc(user?.displayName||'Student')}</strong><div class="muted">${esc(className(user?.classId||''))} • ${esc(activity.time)}</div></div><div class="panel"><div style="font-weight:800;margin-bottom:8px">${activityIcon(activity.type)} ${esc(activity.detail)}</div>${meta.subject?`<div><strong>Subject:</strong> ${esc(meta.subject)}</div>`:''}${meta.replyText?`<div class="template-preview-box" style="margin-top:10px">${esc(meta.replyText)}</div>`:''}${meta.body && !meta.replyText?`<div class="template-preview-box" style="margin-top:10px">${esc(meta.body)}</div>`:''}${meta.recipientLabel?`<div style="margin-top:10px"><strong>To:</strong> ${esc(meta.recipientLabel)}</div>`:''}</div><div class="row">${meta.mailboxUserId?'<button id="activityOpenInboxBtn" class="btn btn-primary">Open related inbox</button>':''}${activity.type==='student_peer_send'?'<button id="activityPeerBtn" class="btn-secondary">Open student-to-student mailbox</button>':''}<button id="activityClearBtn" class="btn-danger">Clear notification</button><button id="activityCloseBtn" class="btn-secondary">Close</button></div></div>`,'compact');
  document.getElementById('activityCloseBtn').onclick=closeModal;
  document.getElementById('activityClearBtn').onclick=()=>{ clearActivity(activity.id); closeModal(); renderAdmin(); };
  const op=document.getElementById('activityOpenInboxBtn'); if(op) op.onclick=()=>{ closeModal(); adminSection='inbox'; staffInboxUserId=meta.mailboxUserId; renderAdmin(); };
  const peer=document.getElementById('activityPeerBtn'); if(peer) peer.onclick=()=>{ closeModal(); openStudentPeerMailboxModal(user?.classId || ''); };
}
function renderDashboardPage(main, students, staff){
  const selectedClassId = dashboardClassTabId || '';
  const items = selectedClassId ? classActivities(selectedClassId) : [];
  const peerCount = selectedClassId ? getStudentPeerMessages(selectedClassId).length : 0;
  main.innerHTML=`<div class="stack"><div class="panel"><div class="split"><div><h2 style="margin:0">Notifications</h2><p class="muted">Use the class tabs to review replies, risky actions, and student email activity.</p></div><label class="selector-item" style="min-width:290px"><input id="dashPeerToggle" type="checkbox" ${state.settings?.allowStudentToStudent?'checked':''}><div><div>Student to student emailing</div><small>${state.settings?.allowStudentToStudent?'Currently on for lesson use.':'Currently off outside lessons.'}</small></div></label></div><div class="row" style="margin-top:14px">${state.classes.map(c=>`<button class="chip-btn ${selectedClassId===c.id?'active':''}" data-dashboard-class="${c.id}">${esc(c.name)} <span class="badge-red">${classActivityCount(c.id)}</span></button>`).join('')}</div>${selectedClassId?`<div class="notification-tools" style="margin-top:14px"><div><strong>${esc(className(selectedClassId))}</strong><span class="mini-note" style="margin-left:8px">${items.length} interaction${items.length===1?'':'s'}</span></div><div class="row"><button id="hideClassNotificationsBtn" class="btn-secondary">Hide</button><button id="clearClassNotificationsBtn" class="btn-danger">Clear class notifications</button></div></div><div class="notification-box" style="margin-top:12px">${items.length?items.map(a=>`<button class="activity-item ${a.read?'':'hinted'}" data-activity-open="${a.id}"><div class="split"><div><strong>${activityIcon(a.type)} ${esc(getUser(a.userId)?.displayName||'Student')}</strong><div class="muted" style="margin-top:4px">${esc(a.detail)}</div></div><span class="mini-note">${esc(a.time)}</span></div></button>`).join(''):'<div class="muted">No notifications for this class yet.</div>'}</div>`:`<div class="notification-box" style="margin-top:14px"><div class="muted">Click a class tab to view its notifications.</div></div>`}</div><div class="grid2"><div class="panel"><div class="split"><div><h2 style="margin:0">Inbox</h2><p class="muted">Open the full inbox page from the separate Inbox tab.</p></div><button id="gotoStaffInboxBtn" class="btn btn-primary">Open inbox page</button></div><div class="soft-panel" style="margin-top:14px">Read student replies in teacher and staff mailboxes without using a modal.</div></div><div class="panel"><div class="split"><div><h2 style="margin:0">Student to student email box</h2><p class="muted">Review messages students have sent to each other.</p></div><button id="dashOpenPeerBoxBtn" class="btn btn-primary">Open box</button></div><div class="soft-panel" style="margin-top:14px"><div style="font-weight:800">${selectedClassId?esc(className(selectedClassId)):'Choose a class'}</div><div class="muted">${selectedClassId?peerCount + ' student-to-student email' + (peerCount===1?'':'s') + ' found for this class.':'Pick a class tab first to review peer emails.'}</div></div></div></div></div>`;
  document.getElementById('dashPeerToggle').onchange=(e)=>{ state.settings.allowStudentToStudent=e.target.checked; saveState(); renderAdmin(); };
  document.querySelectorAll('[data-dashboard-class]').forEach(b=>b.onclick=()=>{ dashboardClassTabId = dashboardClassTabId===b.dataset.dashboardClass ? '' : b.dataset.dashboardClass; renderAdmin(); });
  document.querySelectorAll('[data-activity-open]').forEach(b=>b.onclick=()=>openActivityDetails(b.dataset.activityOpen));
  const hideBtn=document.getElementById('hideClassNotificationsBtn'); if(hideBtn) hideBtn.onclick=()=>{ dashboardClassTabId=''; renderAdmin(); };
  const clearBtn=document.getElementById('clearClassNotificationsBtn'); if(clearBtn) clearBtn.onclick=()=>{ clearClassActivities(selectedClassId); renderAdmin(); };
  document.getElementById('gotoStaffInboxBtn').onclick=()=>{ adminSection='inbox'; renderAdmin(); };
  document.getElementById('dashOpenPeerBoxBtn').onclick=()=>{ if(selectedClassId) openStudentPeerMailboxModal(selectedClassId); };
}
function renderSendPage(main){
  const groups=templateGroupCounts();
  main.innerHTML=`<div class="stack"><div class="split"><div><h2 style="margin:0">Send Email</h2><p class="muted">Choose a simpler template send, compose a new message, or manage templates.</p></div></div>${sendEmailMode==='menu' ? `<div class="grid3"><button class="panel group-card" id="openSendTemplatePage"><div class="tag internal">Send From Template</div><h3 style="margin:0">Choose a library email</h3><div class="muted">Pick a template, make quick edits, and send it.</div></button><button class="panel group-card" id="openComposePage"><div class="tag safe">Compose Email</div><h3 style="margin:0">Write a custom email</h3><div class="muted">Write your own message and optionally save it as an automation.</div></button><button class="panel group-card" id="openTemplateManagerPage"><div class="tag spam">Create Templates</div><h3 style="margin:0">Create or edit templates</h3><div class="muted">Use the full template builder with links and attachments.</div></button></div><div class="panel"><div class="split"><div><h3 style="margin:0">Existing automations</h3><div class="muted">Run, edit, or review saved automations.</div></div><button id="runAutoNowBtn" class="btn-secondary">Run automations now</button></div><div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Name</th><th>Type</th><th>Students</th><th>Frequency</th><th>Qty</th><th>Status</th></tr></thead><tbody>${state.automations.length?state.automations.map(a=>`<tr><td>${esc(a.name)}</td><td>${esc(a.kind==='custom'?'Custom email':'Template')}</td><td>${esc((a.studentIds||[]).map(id=>getUser(id)?.displayName||'').join(', '))}</td><td>${esc(a.frequency)}</td><td>${esc(a.quantity)}</td><td>${a.active?'<span class="tag safe">Active</span>':'<span class="tag phishing">Paused</span>'}</td></tr>`).join(''):'<tr><td colspan="6" class="muted">No automations yet.</td></tr>'}</tbody></table></div></div>`:''}${sendEmailMode==='template' ? `<div class="panel"><div class="split"><div><h3 style="margin:0">Send From Template</h3><div class="muted">The template is already written. Make quick changes here if needed, then send it.</div></div><button id="sendBackBtn" class="btn-secondary">Back</button></div><div class="grid2" style="margin-top:14px"><div class="stack"><div class="field"><label>Template group</label><select id="sendPageGroup">${groups.map(g=>`<option value="${esc(g.group)}">${esc(g.group)}</option>`).join('')}</select></div><div class="field"><label>Template</label><select id="sendPageTemplate"></select></div><div class="field"><label>Subject</label><input id="sendPageSubject" type="text"></div><div class="field"><label>Preview text</label><input id="sendPagePreviewText" type="text"></div><div class="field"><label>Body</label><textarea id="sendPageBody" style="min-height:240px"></textarea></div></div><div class="stack"><div class="field"><label>Choose class</label><select id="sendPageClass"><option value="">Choose a class</option>${state.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Who should receive it?</label><div class="row"><label class="selector-item" style="flex:1"><input type="radio" name="sendPageMode" value="class" checked><div><div>Whole class</div><small>Send to all students in this class.</small></div></label><label class="selector-item" style="flex:1"><input type="radio" name="sendPageMode" value="selected"><div><div>Selected students</div><small>Reveal the list only when needed.</small></div></label></div></div><div id="sendPageStudentsWrap" class="field hidden"><label>Select students</label><div id="sendPageStudents" class="selector-list"></div></div><div class="field"><label>Destination folder</label><select id="sendPageFolder"><option value="inbox">Inbox</option><option value="junk">Junk Email</option><option value="deleted">Deleted Items</option></select></div><div class="field"><label>Type filenames manually</label><input id="sendPageAttachments" type="text" placeholder="e.g. worksheet.pdf, letter.docx"></div><div class="field"><label>Attach files</label><input id="sendPageFiles" type="file" multiple></div>${attachmentSummaryHtml('sendPageFileSummary')}<label class="selector-item"><input id="sendPageAutomationToggle" type="checkbox"><div><div>Make this an automation</div><small>Instead of sending once, save it to run automatically.</small></div></label><div id="sendPageAutomationFields" class="stack hidden" style="margin-top:14px"><div class="field"><label>Automation name</label><input id="sendPageAutoName" type="text" placeholder="Daily template send"></div><div class="field"><label>Frequency</label><select id="sendPageFrequency"><option>Daily</option><option>Weekdays</option><option>Weekly</option></select></div><div class="field"><label>Quantity</label><input id="sendPageQuantity" type="number" min="1" value="1"></div></div><div class="template-preview-box" id="sendPagePreview"></div><div class="row" style="margin-top:14px"><button id="sendPageSubmit" class="btn btn-primary">Send template</button><button id="sendPageSaveAutomation" class="btn-secondary hidden">Save automation</button></div><div id="sendPageMsg"></div></div></div></div>`:''}${sendEmailMode==='compose' ? `<div class="panel"><div class="split"><div><h3 style="margin:0">Compose Email</h3><div class="muted">Full page editor so the message is easier to read and write.</div></div><button id="sendBackBtn" class="btn-secondary">Back</button></div><div class="grid2" style="margin-top:14px"><div><div class="field"><label>From account</label><select id="composePageSender">${state.users.filter(u=>u.role==='teacher'||u.role==='staff').map(u=>`<option value="${u.id}">${esc(u.displayName)} (${esc(u.email)})</option>`).join('')}</select></div><div class="field"><label>Subject</label><input id="composePageSubject" type="text"></div><div class="field"><label>Message</label><textarea id="composePageBody" style="min-height:260px"></textarea></div><div class="field"><label>Type filenames manually</label><input id="composePageAttachments" type="text" placeholder="e.g. rota.docx, reminder.pdf"></div><div class="field"><label>Attach files</label><input id="composePageFiles" type="file" multiple></div>${attachmentSummaryHtml('composePageFileSummary')}</div><div><div class="field"><label>Choose class</label><select id="composePageClass"><option value="">Choose a class</option>${state.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Who should receive it?</label><div class="row"><label class="selector-item" style="flex:1"><input type="radio" name="composePageMode" value="class" checked><div><div>Whole class</div><small>Send to everyone in the class.</small></div></label><label class="selector-item" style="flex:1"><input type="radio" name="composePageMode" value="selected"><div><div>Selected students</div><small>Reveal students only when needed.</small></div></label></div></div><div id="composePageStudentsWrap" class="field hidden"><label>Select students</label><div id="composePageStudents" class="selector-list"></div></div><div class="field"><label>Destination folder</label><select id="composePageFolder"><option value="inbox">Inbox</option><option value="junk">Junk Email</option><option value="deleted">Deleted Items</option></select></div><label class="selector-item"><input id="composePageAutomationToggle" type="checkbox"><div><div>Make this an automation</div><small>Save this custom email to run automatically.</small></div></label><div id="composePageAutomationFields" class="stack hidden" style="margin-top:14px"><div class="field"><label>Automation name</label><input id="composePageAutoName" type="text" placeholder="Weekly reminder"></div><div class="field"><label>Frequency</label><select id="composePageFrequency"><option>Daily</option><option>Weekdays</option><option>Weekly</option></select></div><div class="field"><label>Quantity</label><input id="composePageQuantity" type="number" min="1" value="1"></div></div><div class="row" style="margin-top:14px"><button id="composePageSubmit" class="btn btn-primary">Send email</button><button id="composePageSaveAutomation" class="btn-secondary hidden">Save automation</button></div><div id="composePageMsg"></div></div></div></div>`:''}${sendEmailMode==='manage' ? `<div class="panel"><div class="split"><div><h3 style="margin:0">Create / Edit Templates</h3><div class="muted">Build your own templates with richer options.</div></div><button id="sendBackBtn" class="btn-secondary">Back</button></div><div class="grid2" style="margin-top:14px"><div class="template-editor"><div class="field"><label>Template group</label><select id="tplManageGroup">${groups.map(g=>`<option value="${esc(g.group)}">${esc(g.group)}</option>`).join('')}</select></div><div class="field"><label>Existing template</label><select id="tplManageTemplate"></select></div><div class="field"><label>Type</label><select id="tplManageType"><option value="safe">Safe</option><option value="internal">Internal</option><option value="spam">Spam</option><option value="phishing">Phishing</option></select></div><div class="field"><label>Sender name</label><input id="tplManageSenderName" type="text"></div><div class="field"><label>Sender email</label><input id="tplManageSenderEmail" type="text"></div><div class="field"><label>Subject</label><input id="tplManageSubject" type="text"></div><div class="field"><label>Preview text</label><input id="tplManagePreview" type="text"></div><div class="field"><label>Body</label><textarea id="tplManageBody" style="min-height:220px"></textarea></div></div><div class="template-editor"><div class="field"><label>Destination folder</label><select id="tplManageFolder"><option value="inbox">Inbox</option><option value="junk">Junk Email</option><option value="deleted">Deleted Items</option></select></div><div class="field"><label>Fake link type</label><select id="tplManageLinkTarget"><option value="">No fake link</option><option value="fake-payment">Payment page</option><option value="fake-email">Enter email and password</option><option value="fake-personal">Personal information form</option>${Object.keys(fakePages).map(k=>`<option value="${k}">${esc(fakePages[k].title)}</option>`).join('')}</select></div><div class="field"><label>Type filenames manually</label><input id="tplManageAttachments" type="text" placeholder="e.g. invoice.pdf, form.docx"></div><div class="field"><label>Attach files</label><input id="tplManageFiles" type="file" multiple></div>${attachmentSummaryHtml('tplManageFileSummary')}<div class="template-preview-box" id="tplManagePreviewBox"></div><div class="row"><button id="tplManageSaveChanges" class="btn btn-primary">Save changes</button><button id="tplManageSaveNew" class="btn-secondary">Save as new template</button></div><div id="tplManageMsg"></div></div></div></div>`:''}</div>`;
  const back=document.getElementById('sendBackBtn'); if(back) back.onclick=()=>{ sendEmailMode='menu'; renderAdmin(); };
  const openT=document.getElementById('openSendTemplatePage'); if(openT) openT.onclick=()=>{ sendEmailMode='template'; renderAdmin(); };
  const openC=document.getElementById('openComposePage'); if(openC) openC.onclick=()=>{ sendEmailMode='compose'; renderAdmin(); };
  const openM=document.getElementById('openTemplateManagerPage'); if(openM) openM.onclick=()=>{ sendEmailMode='manage'; renderAdmin(); };
  const run=document.getElementById('runAutoNowBtn'); if(run) run.onclick=()=>{ state.automations.forEach(a=>a.lastRun=''); processAutomations(true); saveState(); openModal('<h2>Automations run</h2><div class="message ok">All active automations have been run once for testing.</div><div class="row" style="margin-top:16px"><button id="closeAutoRun" class="btn-secondary">Close</button></div>', true); document.getElementById('closeAutoRun').onclick=closeModal; };
  if(sendEmailMode==='template') bindSendTemplatePage();
  if(sendEmailMode==='compose') bindComposePage();
  if(sendEmailMode==='manage') bindTemplateManagerPage();
}
function bindSendTemplatePage(){
  bindAttachmentPicker('sendPageFiles','sendPageFileSummary');
  const classSelect=document.getElementById('sendPageClass'); const studentsWrap=document.getElementById('sendPageStudentsWrap'); const students=document.getElementById('sendPageStudents');
  const group=document.getElementById('sendPageGroup'); const tplSelect=document.getElementById('sendPageTemplate');
  function fillTemplateList(){ const list=state.templates.filter(t=>t.group===group.value); tplSelect.innerHTML=list.map(t=>`<option value="${t.id}">${esc(t.subject)}</option>`).join(''); loadTemplate(); }
  function loadTemplate(){ const t=state.templates.find(x=>x.id===tplSelect.value); if(!t) return; document.getElementById('sendPageSubject').value=t.subject||''; document.getElementById('sendPagePreviewText').value=t.preview||''; document.getElementById('sendPageBody').value=t.body||''; document.getElementById('sendPageFolder').value=t.defaultFolder||'inbox'; refreshPreview(); }
  function refreshPreview(){ document.getElementById('sendPagePreview').textContent=document.getElementById('sendPageBody').value||'Preview will appear here.'; }
  function refreshStudents(){ students.innerHTML=selectedSendClassStudentRows(classSelect.value); }
  function syncMode(){ const selected=document.querySelector('input[name="sendPageMode"]:checked')?.value==='selected'; studentsWrap.classList.toggle('hidden', !selected); if(selected) refreshStudents(); }
  function syncAutomation(){ const on=document.getElementById('sendPageAutomationToggle').checked; document.getElementById('sendPageAutomationFields').classList.toggle('hidden', !on); document.getElementById('sendPageSubmit').classList.toggle('hidden', on); document.getElementById('sendPageSaveAutomation').classList.toggle('hidden', !on); }
  group.onchange=fillTemplateList; tplSelect.onchange=loadTemplate; classSelect.onchange=()=>{ if(!studentsWrap.classList.contains('hidden')) refreshStudents(); };
  ['sendPageSubject','sendPagePreviewText','sendPageBody'].forEach(id=>document.getElementById(id).oninput=refreshPreview);
  document.querySelectorAll('input[name="sendPageMode"]').forEach(r=>r.onchange=syncMode); document.getElementById('sendPageAutomationToggle').onchange=syncAutomation;
  fillTemplateList(); syncMode(); syncAutomation();
  document.getElementById('sendPageSubmit').onclick=async ()=>{
    const classId=classSelect.value; let ids=[]; if(!classId){ setMessage(document.getElementById('sendPageMsg'),'warn','Choose a class first.'); return; }
    if(document.querySelector('input[name="sendPageMode"]:checked')?.value==='selected') ids=Array.from(students.querySelectorAll('input:checked')).map(i=>i.value); else ids=classStudentIds(classId);
    if(!ids.length){ setMessage(document.getElementById('sendPageMsg'),'warn','Choose at least one student.'); return; }
    const base=state.templates.find(t=>t.id===tplSelect.value); const template={...base, subject:document.getElementById('sendPageSubject').value, preview:document.getElementById('sendPagePreviewText').value, body:document.getElementById('sendPageBody').value, defaultFolder:document.getElementById('sendPageFolder').value, attachments:await collectFileAttachments('sendPageFiles','sendPageAttachments')};
    ids.forEach(id=>deliverTemplateToUser(state, template, id, template.defaultFolder));
    saveState(); setMessage(document.getElementById('sendPageMsg'),'ok','Template sent successfully.');
  };
  document.getElementById('sendPageSaveAutomation').onclick=async ()=>{
    const classId=classSelect.value; let ids=[]; if(!classId){ setMessage(document.getElementById('sendPageMsg'),'warn','Choose a class first.'); return; }
    if(document.querySelector('input[name="sendPageMode"]:checked')?.value==='selected') ids=Array.from(students.querySelectorAll('input:checked')).map(i=>i.value); else ids=classStudentIds(classId);
    if(!ids.length){ setMessage(document.getElementById('sendPageMsg'),'warn','Choose at least one student.'); return; }
    const base=state.templates.find(t=>t.id===tplSelect.value); const snap={...base, subject:document.getElementById('sendPageSubject').value, preview:document.getElementById('sendPagePreviewText').value, body:document.getElementById('sendPageBody').value, defaultFolder:document.getElementById('sendPageFolder').value, attachments:await collectFileAttachments('sendPageFiles','sendPageAttachments')};
    state.automations.push({id:uid('auto'), kind:'template', name:document.getElementById('sendPageAutoName').value.trim()||'Template automation', active:true, templateId:base.id, templateSnapshot:snap, studentIds:ids, folder:snap.defaultFolder, frequency:document.getElementById('sendPageFrequency').value, quantity:Math.max(1, Number(document.getElementById('sendPageQuantity').value||1)), attachments:cloneAttachments(snap.attachments), lastRun:''});
    saveState(); setMessage(document.getElementById('sendPageMsg'),'ok','Automation saved.');
  };
}
function bindComposePage(){
  bindAttachmentPicker('composePageFiles','composePageFileSummary');
  const classSelect=document.getElementById('composePageClass'); const studentsWrap=document.getElementById('composePageStudentsWrap'); const students=document.getElementById('composePageStudents');
function refreshStudents(){
  const ids = classSelect.value ? classStudentIds(classSelect.value) : [];

  if(!ids.length){
    students.innerHTML = '<div class="muted">Choose a class first.</div>';
    return;
  }

  students.innerHTML = ids.map(id=>{
    const u = getUser(id);
    if(!u) return '';

    return `
      <label class="selector-item" style="display:flex;align-items:flex-start;justify-content:flex-start;gap:12px;width:100%;text-align:left;white-space:normal;padding:12px 14px">
        <input type="checkbox" value="${u.id}" style="margin:2px 0 0 0;flex:0 0 auto;width:16px;height:16px">
        <div style="display:block;flex:1;min-width:0;text-align:left">
          <div style="font-weight:700;line-height:1.3">${esc(u.displayName)}</div>
          <small style="display:block;color:var(--muted);margin-top:2px">${esc(u.email || fullEmail(u.username || ''))}</small>
        </div>
      </label>
    `;
  }).join('');
}
  function syncMode(){ const selected=document.querySelector('input[name="composePageMode"]:checked')?.value==='selected'; studentsWrap.classList.toggle('hidden', !selected); if(selected) refreshStudents(); }
  function syncAutomation(){ const on=document.getElementById('composePageAutomationToggle').checked; document.getElementById('composePageAutomationFields').classList.toggle('hidden', !on); document.getElementById('composePageSubmit').classList.toggle('hidden', on); document.getElementById('composePageSaveAutomation').classList.toggle('hidden', !on); }
  classSelect.onchange=()=>{ if(!studentsWrap.classList.contains('hidden')) refreshStudents(); };
  document.querySelectorAll('input[name="composePageMode"]').forEach(r=>r.onchange=syncMode); document.getElementById('composePageAutomationToggle').onchange=syncAutomation;
  syncMode(); syncAutomation();
  document.getElementById('composePageSubmit').onclick=async ()=>{
    const classId=classSelect.value; const subject=document.getElementById('composePageSubject').value.trim(); const body=document.getElementById('composePageBody').value.trim(); if(!subject||!body){ setMessage(document.getElementById('composePageMsg'),'warn','Enter a subject and message.'); return; }
    let ids=[]; if(!classId){ setMessage(document.getElementById('composePageMsg'),'warn','Choose a class first.'); return; }
    if(document.querySelector('input[name="composePageMode"]:checked')?.value==='selected') ids=Array.from(students.querySelectorAll('input:checked')).map(i=>i.value); else ids=classStudentIds(classId);
    if(!ids.length){ setMessage(document.getElementById('composePageMsg'),'warn','Choose at least one student.'); return; }
    const atts=await collectFileAttachments('composePageFiles','composePageAttachments');
    ids.forEach(id=>deliverInternal(state, document.getElementById('composePageSender').value, id, subject, body, document.getElementById('composePageFolder').value, cloneAttachments(atts)));
    saveState(); setMessage(document.getElementById('composePageMsg'),'ok','Email sent successfully.');
  };
  document.getElementById('composePageSaveAutomation').onclick=async ()=>{
    const classId=classSelect.value; const subject=document.getElementById('composePageSubject').value.trim(); const body=document.getElementById('composePageBody').value.trim(); if(!subject||!body){ setMessage(document.getElementById('composePageMsg'),'warn','Enter a subject and message.'); return; }
    let ids=[]; if(!classId){ setMessage(document.getElementById('composePageMsg'),'warn','Choose a class first.'); return; }
    if(document.querySelector('input[name="composePageMode"]:checked')?.value==='selected') ids=Array.from(students.querySelectorAll('input:checked')).map(i=>i.value); else ids=classStudentIds(classId);
    if(!ids.length){ setMessage(document.getElementById('composePageMsg'),'warn','Choose at least one student.'); return; }
    state.automations.push({id:uid('auto'), kind:'custom', name:document.getElementById('composePageAutoName').value.trim()||'Custom email automation', active:true, senderId:document.getElementById('composePageSender').value, subject, body, studentIds:ids, folder:document.getElementById('composePageFolder').value, frequency:document.getElementById('composePageFrequency').value, quantity:Math.max(1, Number(document.getElementById('composePageQuantity').value||1)), attachments:await collectFileAttachments('composePageFiles','composePageAttachments'), lastRun:''});
    saveState(); setMessage(document.getElementById('composePageMsg'),'ok','Automation saved.');
  };
}
function bindTemplateManagerPage(){
  bindAttachmentPicker('tplManageFiles','tplManageFileSummary');
  const group=document.getElementById('tplManageGroup'); const tpl=document.getElementById('tplManageTemplate');
  function updateList(){ const list=state.templates.filter(t=>t.group===group.value); tpl.innerHTML=list.map(t=>`<option value="${t.id}">${esc(t.subject)}</option>`).join(''); if(list.length) loadTemplate(); else clearForm(); }
  function clearForm(){ ['tplManageSenderName','tplManageSenderEmail','tplManageSubject','tplManagePreview','tplManageBody'].forEach(id=>document.getElementById(id).value=''); document.getElementById('tplManageType').value='safe'; document.getElementById('tplManageFolder').value='inbox'; document.getElementById('tplManageLinkTarget').value=''; renderPreview(); }
  function loadTemplate(){ const t=state.templates.find(x=>x.id===tpl.value); if(!t) return clearForm(); document.getElementById('tplManageType').value=t.type||'safe'; document.getElementById('tplManageSenderName').value=t.senderName||''; document.getElementById('tplManageSenderEmail').value=t.senderEmail||''; document.getElementById('tplManageSubject').value=t.subject||''; document.getElementById('tplManagePreview').value=t.preview||''; document.getElementById('tplManageBody').value=t.body||''; document.getElementById('tplManageFolder').value=t.defaultFolder||'inbox'; document.getElementById('tplManageLinkTarget').value=t.linkTarget||''; renderPreview(); }
  function renderPreview(){ document.getElementById('tplManagePreviewBox').textContent=document.getElementById('tplManageBody').value||'Template preview will appear here.'; }
  function values(){ return {group:group.value,type:document.getElementById('tplManageType').value,senderName:document.getElementById('tplManageSenderName').value.trim(),senderEmail:document.getElementById('tplManageSenderEmail').value.trim(),subject:document.getElementById('tplManageSubject').value.trim(),preview:document.getElementById('tplManagePreview').value.trim(),body:document.getElementById('tplManageBody').value,defaultFolder:document.getElementById('tplManageFolder').value,linkTarget:document.getElementById('tplManageLinkTarget').value}; }
  group.onchange=updateList; tpl.onchange=loadTemplate; ['tplManageSenderName','tplManageSenderEmail','tplManageSubject','tplManagePreview','tplManageBody'].forEach(id=>document.getElementById(id).oninput=renderPreview);
  updateList();
  document.getElementById('tplManageSaveChanges').onclick=async ()=>{ const t=state.templates.find(x=>x.id===tpl.value); if(!t){ setMessage(document.getElementById('tplManageMsg'),'warn','Choose an existing template first.'); return; } const v=values(); if(!v.subject||!v.body){ setMessage(document.getElementById('tplManageMsg'),'warn','Enter a subject and body.'); return; } Object.assign(t,v,{attachments:await collectFileAttachments('tplManageFiles','tplManageAttachments')}); saveState(); setMessage(document.getElementById('tplManageMsg'),'ok','Template updated.'); updateList(); };
  document.getElementById('tplManageSaveNew').onclick=async ()=>{ const v=values(); if(!v.subject||!v.body){ setMessage(document.getElementById('tplManageMsg'),'warn','Enter a subject and body.'); return; } state.templates.push({...v,id:uid('tpl'),attachments:await collectFileAttachments('tplManageFiles','tplManageAttachments')}); saveState(); setMessage(document.getElementById('tplManageMsg'),'ok','New template saved.'); updateList(); tpl.value=state.templates[state.templates.length-1].id; loadTemplate(); };
}



function studentCalendarCurrentDate(){
  return getAnchorDate(studentCalendarAnchor || localDateKey(new Date()));
}

function studentCalendarMonthBase(){
  const anchor=studentCalendarCurrentDate();
  return new Date(anchor.getFullYear(), anchor.getMonth(), 1);
}

function studentCalendarShiftDays(days){
  const d=studentCalendarCurrentDate();
  d.setDate(d.getDate()+days);
  studentCalendarAnchor=localDateKey(d);
}

function studentCalendarShiftMonth(months){
  const d=studentCalendarCurrentDate();
  d.setMonth(d.getMonth()+months);
  studentCalendarAnchor=localDateKey(d);
}

function normaliseCalendarEvent(ev){
  if(!ev) return null;
  return {
    id: ev.id || uid('evt'),
    title: ev.title || ev.name || 'Untitled event',
    date: ev.date || ev.day || '',
    startTime: ev.startTime || ev.time || '',
    endTime: ev.endTime || '',
    description: ev.description || '',
    repeat: ev.repeat || 'none',
    customDates: Array.isArray(ev.customDates) ? ev.customDates : []
  };
}

function studentEventsOn(dateObj){
  return eventsForUserOnDate(currentUserId, dateObj);
}

function prettyDateLong(dateObj){
  return dateObj.toLocaleDateString([], {weekday:'long', day:'numeric', month:'long', year:'numeric'});
}

function studentTimeRowsHtml(dateObj){
  const events=studentEventsOn(dateObj);
  let rows='';

  for(let h=6; h<=21; h++){
    const hh=String(h).padStart(2,'0');
    const label=new Date(`2000-01-01T${hh}:00:00`).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
    const slotEvents=events.filter(ev=>((ev.startTime||'').slice(0,2)===hh));
    rows += `<div class="student-time-row"><div class="student-time-label">${esc(label)}</div><div class="student-slot" data-student-slot="${localDateKey(dateObj)}|${hh}:00"><div class="student-slot-note">Click to add an event</div>${slotEvents.map(ev=>`<button class="student-event-chip" data-student-event="${ev.id}">${esc(ev.title)}<small>${esc(ev.startTime||'All day')}${ev.endTime?` - ${esc(ev.endTime)}`:''}</small></button>`).join('')}</div></div>`;
  }

  const allDay=events.filter(ev=>!ev.startTime);
  if(allDay.length){
    rows = `<div class="student-time-row"><div class="student-time-label">All day</div><div class="student-slot">${allDay.map(ev=>`<button class="student-event-chip" data-student-event="${ev.id}">${esc(ev.title)}<small>${ev.description?esc(ev.description):'No description'}</small></button>`).join('')}</div></div>` + rows;
  }

  return rows;
}
function renderCalendarPanel(){
  const anchor=getAnchorDate(studentCalendarAnchor || localDateKey(new Date()));
  const dayLabel=anchor.toLocaleDateString([], {weekday:'long', day:'numeric', month:'long', year:'numeric'});

  return `<div class="calendar-outlook">
    <div class="calendar-outlook-top">
      <div class="row">
        <button id="studentCalTodayBtn" class="btn-secondary">Today</button>
        <button id="studentCalPrevBtn" class="btn-secondary">◀</button>
        <button id="studentCalNextBtn" class="btn-secondary">▶</button>
        <div style="font-size:18px;font-weight:800">${esc(dayLabel)}</div>
      </div>
    </div>

    <div class="calendar-main">
      ${renderCalendarForUser(currentUserId, 'day', studentCalendarAnchor, false)}
    </div>
  </div>`;
}
function bindStudentCalendarPanel(root=document){
  root.querySelectorAll('[data-student-anchor]').forEach(b=>{
    b.onclick=()=>{
      studentCalendarAnchor=b.dataset.studentAnchor;
      mailFolder='calendar';
      renderMailbox();
    };
  });

  root.querySelectorAll('[data-student-date]').forEach(b=>{
    b.onclick=()=>{
      studentCalendarAnchor=b.dataset.studentDate;
      mailFolder='calendar';
      renderMailbox();
    };
  });

  const prev=root.querySelector('#studentCalPrevBtn');
  if(prev) prev.onclick=()=>{
    studentCalendarShiftDays(-1);
    mailFolder='calendar';
    renderMailbox();
  };

  const next=root.querySelector('#studentCalNextBtn');
  if(next) next.onclick=()=>{
    studentCalendarShiftDays(1);
    mailFolder='calendar';
    renderMailbox();
  };

  const today=root.querySelector('#studentCalTodayBtn');
  if(today) today.onclick=()=>{
    studentCalendarAnchor=localDateKey(new Date());
    mailFolder='calendar';
    renderMailbox();
  };

  const miniPrev=root.querySelector('#studentMiniPrevMonth');
  if(miniPrev) miniPrev.onclick=()=>{
    studentCalendarShiftMonth(-1);
    mailFolder='calendar';
    renderMailbox();
  };

  const miniNext=root.querySelector('#studentMiniNextMonth');
  if(miniNext) miniNext.onclick=()=>{
    studentCalendarShiftMonth(1);
    mailFolder='calendar';
    renderMailbox();
  };

  const newBtn=root.querySelector('#studentNewEventBtn');
  if(newBtn) newBtn.onclick=()=>openStudentEventModal(studentCalendarAnchor, '');

  root.querySelectorAll('[data-student-slot]').forEach(b=>{
    b.onclick=(e)=>{
      if(e.target.closest('[data-student-event]')) return;
      const [date,time]=b.dataset.studentSlot.split('|');
      openStudentEventModal(date,time);
    };
  });

  root.querySelectorAll('[data-student-event]').forEach(b=>{
    b.onclick=(e)=>{
      e.stopPropagation();
      openStudentEventModal(studentCalendarAnchor,'',b.dataset.studentEvent);
    };
  });
}
function openStudentEventModal(dateStr='', timeStr='', eventId=''){
  const list=Array.isArray(state.events[currentUserId])?state.events[currentUserId]:[];
  const existing=eventId ? list.find(ev=>ev.id===eventId) : null;
  const dateVal=existing?.date || dateStr || new Date().toISOString().slice(0,10);
  const timeVal=existing?.startTime || timeStr || '';
  openModal(`<h2>${existing?'Edit event':'New event'}</h2><div class="grid2"><div class="field"><label>Title</label><input id="studentEvtTitle" type="text" value="${esc(existing?.title||'')}"></div><div class="field"><label>Date</label><input id="studentEvtDate" type="date" value="${esc(dateVal)}"></div><div class="field"><label>Start time</label><input id="studentEvtStart" type="time" value="${esc(timeVal)}"></div><div class="field"><label>End time</label><input id="studentEvtEnd" type="time" value="${esc(existing?.endTime||'')}"></div></div><div class="field"><label>Description</label><textarea id="studentEvtDesc">${esc(existing?.description||'')}</textarea></div><div class="row"><button id="saveStudentEvtBtn" class="btn btn-primary">Save event</button>${existing?'<button id="deleteStudentEvtBtn" class="btn-danger">Delete</button>':''}<button id="cancelStudentEvtBtn" class="btn-secondary">Cancel</button></div><div id="studentEvtMsg"></div>`, 'compact');
  document.getElementById('cancelStudentEvtBtn').onclick=closeModal;
document.getElementById('saveStudentEvtBtn').onclick=()=>{
  const title=document.getElementById('studentEvtTitle').value.trim();
  const date=document.getElementById('studentEvtDate').value;
  const startTime=document.getElementById('studentEvtStart').value;
  const endTime=document.getElementById('studentEvtEnd').value;
  const description=document.getElementById('studentEvtDesc').value.trim();

  if(!title || !date){
    setMessage(document.getElementById('studentEvtMsg'),'warn','Enter a title and date.');
    return;
  }

  state.events[currentUserId]=Array.isArray(state.events[currentUserId]) ? state.events[currentUserId] : [];

  const payload = normaliseCalendarEvent({
    id: existing?.id || uid('evt'),
    title,
    date,
    startTime,
    endTime,
    description
  });

  const idx=state.events[currentUserId].findIndex(ev=>ev.id===payload.id);
  if(idx>=0){
    state.events[currentUserId][idx]=payload;
  } else {
    state.events[currentUserId].push(payload);
  }

  studentCalendarAnchor=date;
  saveState();
  closeModal();
  renderMailbox();
};
  const del=document.getElementById('deleteStudentEvtBtn');
  if(del) del.onclick=()=>{ state.events[currentUserId]=(state.events[currentUserId]||[]).filter(ev=>ev.id!==existing.id); saveState(); closeModal(); renderMailbox(); };
}
function renderMailList(){
  document.querySelectorAll('.folder-btn').forEach(btn=>btn.classList.toggle('active', btn.dataset.folder===mailFolder));
  const titles={inbox:'Inbox',junk:'Junk Email',deleted:'Deleted Items',sent:'Sent Items',calendar:'Calendar'};
  document.getElementById('folderTitle').textContent=titles[mailFolder];
  const list=document.getElementById('mailList');
  if(isStaffUser() && mailFolder==='templates'){
    renderStaffTemplateList();
    return;
  }

  if(isStaffUser() && mailFolder==='calendar'){
    document.getElementById('folderTitle').textContent='Calendar';
    document.getElementById('messageCount').textContent='Planner';
    list.innerHTML = renderStaffMailboxCalendarList();
    bindStaffMailboxCalendar();
    return;
  }
  if(mailFolder==='calendar'){
    const anchor=studentCalendarCurrentDate();
    const monthBase=studentCalendarMonthBase();
    const monthLabel=formatMonthLabel(monthBase);
    const gridStart=startOfWeek(monthBase);
    const days=[];
    for(let i=0;i<42;i++){
      const d=new Date(gridStart);
      d.setDate(gridStart.getDate()+i);
      days.push(d);
    }

    document.getElementById('messageCount').textContent=(state.events[currentUserId]||[]).length;
    list.innerHTML=`<div class="student-calendar-side" style="padding:16px">
      <div class="student-calendar-tools">
        <button id="studentNewEventBtn" class="btn btn-primary">New event</button>
      </div>

      <div class="student-mini-month">
        <div class="student-mini-head">
          <button id="studentMiniPrevMonth" class="btn-secondary">◀</button>
          <strong>${esc(monthLabel)}</strong>
          <button id="studentMiniNextMonth" class="btn-secondary">▶</button>
        </div>

        <div class="student-mini-grid">
          ${['M','T','W','T','F','S','S'].map(h=>`<div class="head">${h}</div>`).join('')}
          ${days.map(d=>`<button class="student-mini-date ${sameDate(d,anchor)?'is-selected':''} ${d.getMonth()!==monthBase.getMonth()?'is-muted':''} ${sameDate(d,getAnchorDate(localDateKey(new Date())))?'is-today':''}" data-student-date="${localDateKey(d)}">${d.getDate()}</button>`).join('')}
        </div>
      </div>

      <div class="student-selected-box">
        <div style="font-weight:800;margin-bottom:6px">Selected date</div>
        <div class="muted">${esc(prettyDateLong(anchor))}</div>
        <div style="margin-top:12px">
          ${studentEventsOn(anchor).length
            ? studentEventsOn(anchor).map(ev=>`<button class="student-event-chip" data-student-event="${ev.id}">${esc(ev.title)}<small>${esc(ev.startTime||'All day')}${ev.endTime?` - ${esc(ev.endTime)}`:''}</small></button>`).join('')
            : '<div class="muted">No events on this date.</div>'}
        </div>
      </div>
    </div>`;
    bindStudentCalendarPanel(list);
    return;
  }

  const items=currentMailItems();
  document.getElementById('messageCount').textContent=items.length;
  if(!selectedMailId && items[0]) selectedMailId=items[0].id;
  if(!items.find(i=>i.id===selectedMailId)) selectedMailId=items[0]?.id||null;

  list.innerHTML = items.length
    ? items.map(m=>`<button class="mail-item ${m.id===selectedMailId?'active':''}" data-mail="${m.id}"><div class="mail-top"><div style="min-width:0"><div class="mail-from">${m.read?'':'<span class="dot"></span>'}<span class="truncate ${m.read?'read':'unread'}">${esc(m.senderName)}</span>${m.flagged?'<span style="color:#f59e0b">⚑</span>':''}</div><div class="truncate ${m.read?'read':'unread'}">${esc(m.subject)}</div></div><span class="time">${esc(m.timeLabel)}</span></div><div class="preview truncate">${esc(m.preview)}</div></button>`).join('')
    : '<div class="panel" style="margin:16px">No messages in this folder.</div>';

document.querySelectorAll('[data-mail]').forEach(b=>b.onclick=()=>{
  selectedMailId=b.dataset.mail;
  const m=currentMailItems().find(x=>x.id===selectedMailId);
  if(m) m.read=true;
  saveState();
  if(isStudentMobile()){
    mobileStudentTab='mail';
    mobileStudentView='detail';
  }
  renderMailbox();
});
}
function renderStaffTemplateList(){
  const list=document.getElementById('mailList');
  const items=state.templates.slice();

  document.getElementById('folderTitle').textContent='Templates';
  document.getElementById('messageCount').textContent=items.length;

  if(!selectedTemplateId && items[0]) selectedTemplateId=items[0].id;
  if(!items.find(t=>t.id===selectedTemplateId)) selectedTemplateId=items[0]?.id || '';

  list.innerHTML = items.length
    ? items.map(t=>`
      <button class="mail-item ${t.id===selectedTemplateId?'active':''}" data-template="${t.id}">
        <div class="mail-top">
          <div style="min-width:0">
            <div class="mail-from">
              <span class="truncate unread">${esc(t.senderName)}</span>
            </div>
            <div class="truncate read">${esc(t.subject)}</div>
          </div>
          <span class="time">${esc(t.group)}</span>
        </div>
        <div class="preview truncate">${esc(t.preview)}</div>
      </button>
    `).join('')
    : '<div class="panel" style="margin:16px">No templates found.</div>';

  document.querySelectorAll('[data-template]').forEach(b=>{
    b.onclick=()=>{
      selectedTemplateId=b.dataset.template;
      renderMailbox();
    };
  });
}
function renderStaffTemplateReader(){
  const root = document.getElementById('readerInner');
  const tpl = state.templates.find(t => t.id === selectedTemplateId) || null;

  if(!tpl){
    root.innerHTML = '<div class="panel">Select a template to preview it.</div>';
    return;
  }

  const isEditing = root.dataset.editing === tpl.id;

  if(!isEditing){
    root.innerHTML = `
      <div class="subject-line">
        <div>
          <h1>${esc(tpl.subject)}</h1>
          <div class="from-box">
            <strong>From:</strong> ${esc(tpl.senderName)} &lt;${esc(tpl.senderEmail)}&gt;
          </div>
        </div>
        <div class="tag">${esc(tpl.group)}</div>
      </div>

      <div class="mail-body">${esc(tpl.body)}</div>

      <div class="row" style="margin-top:18px">
        <button id="staffEditTemplateBtn" class="btn-secondary">Edit this template</button>
        <button id="staffSendTemplateBtn" class="btn btn-primary">Send this template</button>
      </div>
    `;

    const editBtn = document.getElementById('staffEditTemplateBtn');
    const sendBtn = document.getElementById('staffSendTemplateBtn');

    if(editBtn){
      editBtn.onclick = ()=>{
        root.dataset.editing = tpl.id;
        renderStaffTemplateReader();
      };
    }

    if(sendBtn){
      sendBtn.onclick = ()=>{
        root.dataset.editing = '';
        selectedTemplateId = tpl.id;
        openTemplateSendModal(tpl.id);
      };
    }

    return;
  }

  root.innerHTML = `
    <div class="subject-line">
      <div style="width:100%">
        <input id="editTemplateSubject" type="text" style="width:100%;font-size:20px;font-weight:800;padding:8px;margin-bottom:10px">
        <div class="from-box">
          <strong>From:</strong> ${esc(tpl.senderName)} &lt;${esc(tpl.senderEmail)}&gt;
        </div>
      </div>
    </div>

    <textarea id="editTemplateBody" style="width:100%;height:220px;margin-top:12px;padding:10px;font-size:14px;line-height:1.5"></textarea>

    <div class="row" style="margin-top:18px">
      <button id="saveTemplateBtn" class="btn btn-primary">Save changes</button>
      <button id="cancelEditTemplateBtn" class="btn-secondary">Cancel</button>
    </div>
  `;

  document.getElementById('editTemplateSubject').value = tpl.subject || '';
  document.getElementById('editTemplateBody').value = tpl.body || '';

  document.getElementById('saveTemplateBtn').onclick = ()=>{
    tpl.subject = document.getElementById('editTemplateSubject').value;
    tpl.body = document.getElementById('editTemplateBody').value;
    saveState();
    root.dataset.editing = '';
    selectedTemplateId = tpl.id;
    renderMailbox();
  };

  document.getElementById('cancelEditTemplateBtn').onclick = ()=>{
    root.dataset.editing = '';
    renderStaffTemplateReader();
  };
}
function renderMailReader(){
  const root=document.getElementById('readerInner');

  if(isStaffUser() && mailFolder==='templates'){
    renderStaffTemplateReader();
    return;
  }

  if(isStaffUser() && mailFolder==='calendar'){
    root.innerHTML = renderStaffMailboxCalendarReader();
    bindStaffMailboxCalendarReader();
    return;
  }

  if(mailFolder==='calendar'){
    root.innerHTML=renderCalendarPanel();
    bindStudentCalendarPanel(root);
    return;
  }

if(composeMode==='new'){
  root.innerHTML=renderComposeReply(null);

  const c=document.getElementById('closeComposeBtn');
  if(c) c.onclick=()=>{ composeMode=null; renderMailReader(); };

  const s=document.getElementById('sendMsgBtn');
  if(s) s.onclick=sendCurrentMessage;

  bindComposeAddressField(root);

  return;
}

  const mail=currentMail();
  if(!mail){
    root.innerHTML='<div class="panel">Select an email to start.</div>';
    return;
  }

  const badge=mail.category==='phishing'?'phishing':mail.category==='spam'?'spam':mail.category==='internal'?'internal':'safe';
  const badgeLabel=mail.category==='phishing'?'Suspicious training email':mail.category==='spam'?'Junk / spam':mail.category==='internal'?'Internal message':'Standard message';

  root.innerHTML=`<div class="subject-line">
    <div>
      <h1>${esc(mail.subject)}</h1>
      <div class="from-box ${showHint && mail.hints.some(h=>h.target==='from')?'hinted':''}">
        <strong>From:</strong> ${esc(mail.senderName)} &lt;${esc(mail.senderEmail)}&gt;
        &nbsp; <span class="muted">${esc(mail.sentAt)}</span>
      </div>
    </div>
    <div class="tag ${badge}">${badgeLabel}</div>
  </div>
  ${showHint?`<div class="hint-card"><h3>Things to check</h3><ul>${mail.hints.map(h=>`<li>${esc(h.label)}</li>`).join('')}</ul></div>`:''}
  <div class="mail-body ${showHint && mail.hints.some(h=>h.target==='body')?'hinted':''}">${bodyHtml(mail)}</div>
  ${mail.attachments?.length?`<div class="attachment-wrap">${mail.attachments.map(a=>`<div class="attachment"><div><strong>${esc(a.filename)}</strong><div class="muted">${esc(a.filetype)} • ${esc(a.size)}</div></div><button class="btn-secondary" data-open-att="${a.id}">Open</button></div>`).join('')}</div>`:''}
  ${(mail.replies||[]).map(r=>`<div class="reply-card"><div class="reply-head"><strong>You ${r.type==='forward'?'forwarded':'replied'}</strong><span>${esc(r.time)}</span></div><div style="white-space:pre-wrap;line-height:1.8">${esc(r.text)}</div></div>`).join('')}
  ${composeMode?renderComposeReply(mail):''}`;

  root.querySelectorAll('[data-link]').forEach(el=>el.onclick=()=>openFakePage(el.dataset.link));
  root.querySelectorAll('[data-open-att]').forEach(el=>el.onclick=()=>openAttachment(mail, el.dataset.openAtt));

  const c=document.getElementById('closeComposeBtn');
  if(c) c.onclick=()=>{ composeMode=null; renderMailReader(); };

  const s=document.getElementById('sendMsgBtn');
  if(s) s.onclick=sendCurrentMessage;
}

bindEvents();
init();
