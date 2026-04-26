import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCOyG_VoHjs3GYvM5ZpWIzM_D5hWpTf6ZY",
  authDomain: "plc-mail.firebaseapp.com",
  projectId: "plc-mail",
  storageBucket: "plc-mail.firebasestorage.app",
  messagingSenderId: "981001695541",
  appId: "1:981001695541:web:b8023c2ee391c360fd5c7c"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db, doc, getDoc, setDoc, onSnapshot };