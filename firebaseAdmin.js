import admin from "firebase-admin";

let app;

export function getFirebaseAdmin() {
  if (app) return app;

  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp();

  return app;
}

export async function verifyFirebaseTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Missing Bearer token");
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  if (!idToken) {
    throw new Error("Empty Bearer token");
  }

  const decoded = await getFirebaseAdmin().auth().verifyIdToken(idToken);
  return decoded;
}