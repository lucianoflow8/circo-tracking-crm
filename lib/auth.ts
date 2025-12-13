// lib/auth.ts
import { cookies, headers } from "next/headers";
import { jwtVerify, SignJWT } from "jose";

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "crm_session";
const AUTH_SECRET = process.env.AUTH_SECRET || "CHANGE_ME_IN_ENV";

function getSecretKey() {
  return new TextEncoder().encode(AUTH_SECRET);
}

type SessionPayload = {
  sub: string; // userId
  email?: string;
  name?: string | null;
};

export async function signSession(payload: SessionPayload, maxAgeSeconds = 60 * 60 * 24 * 7) {
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    email: payload.email,
    name: payload.name ?? null,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + maxAgeSeconds)
    .sign(getSecretKey());

  return token;
}

export async function setSessionCookie(token: string, maxAgeSeconds = 60 * 60 * 24 * 7) {
  const isProd = process.env.NODE_ENV === "production";

  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function clearSessionCookie() {
  cookies().set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

function readTokenFromRequest(): string | null {
  // 1) Cookie
  const fromCookie = cookies().get(COOKIE_NAME)?.value;
  if (fromCookie) return fromCookie;

  // 2) Authorization header (Bearer)
  const auth = headers().get("authorization") || headers().get("Authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return null;
}

export async function getCurrentUserId(): Promise<string | null> {
  const token = readTokenFromRequest();
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    return null;
  } catch {
    return null;
  }
}

export async function requireCurrentUserId(): Promise<string> {
  const uid = await getCurrentUserId();
  if (!uid) throw new Error("No autenticado");
  return uid;
}
