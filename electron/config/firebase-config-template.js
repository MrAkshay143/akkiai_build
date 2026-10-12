// ──────────────────────────────────────────────────────────────────
//  FIREBASE CONFIG — Replace with your own Firebase project values
// ──────────────────────────────────────────────────────────────────
//
// HOW TO SET UP FIREBASE:
//
// Step 1: Create a Firebase project
//   Go to https://console.firebase.google.com
//   Click "Add project" → name it "akki-ai"
//   Disable Google Analytics → Create
//
// Step 2: Enable Google Authentication
//   Left menu → Authentication → Sign-in method
//   Click "Google" → Enable → Set your support email → Save
//   Copy the "Web client ID" shown here (needed below)
//
// Step 3: Get Firebase config
//   Project Overview → Add app → Web (</> icon)
//   Register app name "akki-ai-desktop"
//   Copy the firebaseConfig values and paste below
//
// Step 4: Enable Firestore Database
//   Left menu → Firestore Database → Create database
//   Choose "asia-south1" (Mumbai, closest to BD)
//   Start in test mode → Enable
//
// ──────────────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
  // Google OAuth Web Client ID (from Authentication → Google → Web client ID)
  oauthClientId: 'YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com',
}

module.exports = { FIREBASE_CONFIG }
