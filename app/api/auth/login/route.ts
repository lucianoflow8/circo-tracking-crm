// app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Faltan campos" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return NextResponse.json(
        { error: "Usuario o contraseña incorrectos" },
        { status: 401 }
      );
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);

    if (!isValid) {
      return NextResponse.json(
        { error: "Usuario o contraseña incorrectos" },
        { status: 401 }
      );
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
    };

    // 👉 armamos la respuesta
    const res = NextResponse.json({ user: safeUser }, { status: 200 });

    // 👉 seteamos cookie con el id del usuario
    res.cookies.set("crm_user_id", safeUser.id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });

    return res;
  } catch (error) {
    console.error("Login error", error);
    return NextResponse.json(
      { error: "Error interno en login" },
      { status: 500 }
    );
  }
}