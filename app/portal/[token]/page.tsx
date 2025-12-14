"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

/* ========= Tipos básicos ========= */

type MessageStatus = "pending" | "sent" | "delivered" | "read";

interface ChatSummary {
  id: string;
  name: string;
  lastMessage: string;
  lastMessageAt: string | null;
  unreadCount?: number;

  avatarUrl?: string;
  profilePicUrl?: string;
  photoUrl?: string;

  lineId?: string | null;
  phone?: string | null;
  isGroup?: boolean;

  [key: string]: any;
}

interface MessageMedia {
  mimetype: string;
  fileName?: string | null;
  dataUrl: string;
}

type MessageType = "text" | "image" | "document" | "audio" | "media" | "unknown";

interface Message {
  id: string;
  fromMe: boolean;
  body: string;
  timestamp: string;
  status?: MessageStatus;

  senderName?: string;
  senderNumber?: string;
  senderAvatar?: string | null;

  type?: MessageType;
  media?: MessageMedia | null;
}

type FilterMode = "all" | "unread" | "groups";

/* ========= Helpers ========= */

const getAvatarFromChat = (chat: ChatSummary | null | undefined): string | null => {
  if (!chat) return null;
  if (chat.avatarUrl) return chat.avatarUrl;
  if (chat.profilePicUrl) return chat.profilePicUrl;
  if (chat.photoUrl) return chat.photoUrl;

  for (const [key, value] of Object.entries(chat as Record<string, any>)) {
    if (
      typeof value === "string" &&
      value.startsWith("http") &&
      /(avatar|photo|pic|image|img)/i.test(key)
    ) {
      return value;
    }
  }

  return null;
};

const formatPhone = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  if (raw.startsWith("+")) return raw;
  return `+${raw}`;
};

const isGroupChat = (chat: ChatSummary | null | undefined): boolean => {
  if (!chat) return false;
  if (typeof chat.isGroup === "boolean") return chat.isGroup;
  return chat.id.endsWith("@g.us");
};

const getChatDisplayName = (chat: ChatSummary | null | undefined): string => {
  if (!chat) return "Sin chat seleccionado";

  const group = isGroupChat(chat);
  const rawName = (chat.name || "").trim();
  const phoneRaw = (chat.phone as string | null) ?? null;

  if (group) {
    if (rawName && !/^\d+$/.test(rawName)) return rawName;
    return rawName || "Grupo sin nombre";
  }

  if (rawName && rawName !== phoneRaw) {
    return rawName;
  }

  if (phoneRaw) {
    return formatPhone(phoneRaw) ?? "Sin nombre";
  }

  return rawName || "Sin nombre";
};

const formatMessageBody = (msg: Message): string => {
  let body = msg.body ?? "";
  const trimmed = body.trim();
  const hasMediaObj = !!msg.media;

  if (!trimmed) {
    if (hasMediaObj) {
      if (msg.type === "image") {
        body = "";
      } else if (msg.type === "document") {
        body = msg.media?.fileName || "📄 Documento";
      } else if (msg.type === "audio") {
        body = "";
      } else {
        body = "[adjunto]";
      }
    } else {
      if (msg.type === "image") {
        body = "📷 Imagen";
      } else if (msg.type === "audio") {
        body = "🎧 Audio";
      } else if (msg.type === "document") {
        body = "📄 Documento";
      } else {
        body = "[adjunto]";
      }
    }
  }

  if (!msg.fromMe && msg.senderName) {
    const core = body.trim();
    if (!core) {
      body = msg.senderName;
    } else if (!core.startsWith(msg.senderName + "\n") && !core.startsWith(msg.senderName + " ")) {
      body = `${msg.senderName}\n${core}`;
    }
  }

  return body;
};

const formatTime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getStatusIcon = (status?: MessageStatus) => {
  if (!status) return null;
  switch (status) {
    case "pending":
      return "⏳";
    case "sent":
      return "✓";
    case "delivered":
      return "✓✓";
    case "read":
      return "✓✓";
    default:
      return null;
  }
};

/**
 * ✅ helper: arma query string con token + lineId (si existe)
 * - token SIEMPRE
 * - lineId solo si lo tenemos (evita mezclar líneas)
 */
const buildPortalQuery = (token: string, chat?: ChatSummary | null) => {
  const t = (token || "").trim();
  const lineId = chat?.lineId ? String(chat.lineId).trim() : "";
  const params = new URLSearchParams();
  if (t) params.set("token", t);
  if (lineId) params.set("lineId", lineId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

/* ========= Componente de chat para cajero ========= */

function AgentChat() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChat, setActiveChat] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingMedia, setPendingMedia] = useState<MessageMedia | null>(null);
  const [uploading, setUploading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [searchTerm, setSearchTerm] = useState("");

  // ==== Estado para modal de grupos (versión final única) ====
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupSelected, setGroupSelected] = useState<string[]>([]);
  const [groupAdmins, setGroupAdmins] = useState<string[]>([]);
  const [groupAdminsOnly, setGroupAdminsOnly] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupAvatar, setGroupAvatar] = useState<MessageMedia | null>(null);
  const groupAvatarInputRef = useRef<HTMLInputElement | null>(null);

  // ====== FETCH CHATS (con token del portal) ======
  useEffect(() => {
    if (!token) {
      setError("Token inválido o enlace vencido");
      setChats([]);
      return;
    }

    const fetchChats = async () => {
      try {
        setLoadingChats(true);
        setError(null);

        const res = await fetch(`/api/agent-portal/chats?token=${encodeURIComponent(token)}`, {
          cache: "no-store",
        });

        const data = await res.json().catch(() => ({} as any));

        if (!res.ok) {
          console.error("[AgentChat] Error /agent-portal/chats:", data);
          setError(data.error || "Error al cargar chats");
          setChats([]);
          return;
        }

        const raw: ChatSummary[] = data.chats || [];
        setChats(raw);

        if (!activeChat && raw.length) {
          setActiveChat(raw[0]);
        } else if (activeChat && raw.length) {
          // refrescar activeChat para que mantenga lineId actualizado
          const updated = raw.find((c) => c.id === activeChat.id);
          if (updated) setActiveChat(updated);
        }
      } catch (e: any) {
        console.error(e);
        setError(e.message || "Error al cargar chats");
        setChats([]);
      } finally {
        setLoadingChats(false);
      }
    };

    fetchChats();
    const interval = setInterval(fetchChats, 15000);
    return () => clearInterval(interval);
  }, [token, activeChat?.id]);

  // ====== FETCH MENSAJES (✅ con token + lineId) ======
  useEffect(() => {
    if (!activeChat) return;

    let cancelled = false;
    let first = true;

    const fetchMessages = async () => {
      try {
        if (first) setLoadingMessages(true);
        setError(null);

        const q = buildPortalQuery(token, activeChat);

        const res = await fetch(
          `/api/agent-portal/chats/${encodeURIComponent(activeChat.id)}/messages${q}`,
          { cache: "no-store" }
        );

        const data = await res.json().catch(() => ({} as any));

        if (!res.ok) {
          console.error("[AgentChat] Error /agent-portal/chats/[chatId]/messages:", data);
          if (!cancelled) setError(data.error || "Error al cargar mensajes");
          return;
        }

        if (cancelled) return;
        setMessages(data.messages || []);
      } catch (e: any) {
        console.error(e);
        if (!cancelled) setError(e.message || "Error al cargar mensajes");
      } finally {
        if (!cancelled && first) {
          setLoadingMessages(false);
          first = false;
        }
      }
    };

    fetchMessages();
    const interval = setInterval(fetchMessages, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeChat?.id, token]);

  // Scroll al último mensaje
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // seleccionar chat y limpiar badge de no leído + marcar leído en backend (✅ con token + lineId)
  const handleSelectChat = (chat: ChatSummary) => {
    setActiveChat(chat);
    setMessages([]);

    setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, unreadCount: 0 } : c)));

    const q = buildPortalQuery(token, chat);

    fetch(`/api/agent-portal/chats/${encodeURIComponent(chat.id)}/read${q}`, {
      method: "POST",
    }).catch(() => {});
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;

      setPendingMedia({
        dataUrl: result,
        fileName: file.name,
        mimetype: file.type || "application/octet-stream",
      });
    };
    reader.readAsDataURL(file);
  };

  // ✅ enviar texto con token + lineId
  const sendTextMessage = async (text: string) => {
    if (!activeChat || !text.trim()) return;

    const tempId = `temp-${Date.now()}`;
    const optimistic: Message = {
      id: tempId,
      fromMe: true,
      body: text.trim(),
      timestamp: new Date().toISOString(),
      status: "pending",
      type: "text",
      media: null,
    };

    setMessages((prev) => [...prev, optimistic]);
    setInput("");

    try {
      setSending(true);
      setError(null);

      const q = buildPortalQuery(token, activeChat);

      const res = await fetch(
        `/api/agent-portal/chats/${encodeURIComponent(activeChat.id)}/messages${q}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: optimistic.body }),
        }
      );

      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(data.error || "Error al enviar mensaje");

      const saved: Message | undefined = data.message;

      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? saved ?? { ...optimistic, status: "sent" } : m))
      );
    } catch (e: any) {
      console.error(e);
      setError(e.message || "Error al enviar mensaje");
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, status: "pending" } : m)));
    } finally {
      setSending(false);
    }
  };

  // ✅ enviar media con token + lineId
  const sendMediaMessage = async (text: string, media: MessageMedia) => {
    if (!activeChat) return;

    const tempId = `temp-file-${Date.now()}`;
    let msgType: MessageType = "media";
    const mt = media.mimetype || "";
    if (mt.startsWith("image/")) msgType = "image";
    else if (mt.startsWith("audio/")) msgType = "audio";
    else if (mt === "application/pdf" || mt.startsWith("application/")) msgType = "document";

    const optimistic: Message = {
      id: tempId,
      fromMe: true,
      body: text.trim(),
      timestamp: new Date().toISOString(),
      status: "pending",
      type: msgType,
      media,
    };

    setMessages((prev) => [...prev, optimistic]);
    setInput("");
    setPendingMedia(null);

    try {
      setUploading(true);
      setError(null);

      const q = buildPortalQuery(token, activeChat);

      const res = await fetch(
        `/api/agent-portal/chats/${encodeURIComponent(activeChat.id)}/messages${q}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: optimistic.body, media }),
        }
      );

      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(data.error || "Error al enviar archivo");

      const saved: Message | undefined = data.message;

      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? saved ?? { ...optimistic, status: "sent" } : m))
      );
    } catch (e: any) {
      console.error(e);
      setError(e.message || "Error al enviar archivo");
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, status: "pending" } : m)));
    } finally {
      setUploading(false);
    }
  };

  const handleSend = async () => {
    if (!activeChat) return;
    if (pendingMedia) {
      await sendMediaMessage(input, pendingMedia);
    } else if (input.trim()) {
      await sendTextMessage(input);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const activePhoneFormatted =
    activeChat && !isGroupChat(activeChat) ? formatPhone(activeChat.phone ?? null) : null;

  // ====== Filtros ======
  const normalizedSearch = searchTerm.trim().toLowerCase();

  const filteredChats = chats.filter((chat) => {
    if (filterMode === "unread" && !chat.unreadCount) return false;
    if (filterMode === "groups" && !isGroupChat(chat)) return false;

    if (!normalizedSearch) return true;

    const displayName = getChatDisplayName(chat).toLowerCase();
    const phone = (formatPhone(chat.phone ?? null) || "").toLowerCase();

    return displayName.includes(normalizedSearch) || phone.includes(normalizedSearch);
  });

  // ====== helpers del modal de grupo ======
  const toggleParticipant = (chatId: string) => {
    setGroupSelected((prev) => {
      if (prev.includes(chatId)) {
        setGroupAdmins((adminsPrev) => adminsPrev.filter((id) => id !== chatId));
        return prev.filter((id) => id !== chatId);
      }
      return [...prev, chatId];
    });
  };

  const toggleAdmin = (chatId: string) => {
    setGroupAdmins((prev) => (prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId]));
    setGroupSelected((prev) => (prev.includes(chatId) ? prev : [...prev, chatId]));
  };

  const handleGroupAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;
      setGroupAvatar({
        dataUrl: result,
        fileName: file.name,
        mimetype: file.type || "image/jpeg",
      });
    };
    reader.readAsDataURL(file);
  };

  // ✅ crear grupo con token (y opcional lineId si quisieras, pero acá no aplica chat puntual)
  const handleCreateGroup = async () => {
    const name = groupName.trim();
    if (!name) {
      setGroupError("Poné un nombre para el grupo.");
      return;
    }

    try {
      setCreatingGroup(true);
      setGroupError(null);

      const q = buildPortalQuery(token, null);

      const res = await fetch(`/api/agent-portal/chats/groups${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: groupDescription.trim() || undefined,
          participants: groupSelected,
          messagesAdminsOnly: groupAdminsOnly,
          adminNumbers: groupAdmins,
          avatar: groupAvatar
            ? {
                mimetype: groupAvatar.mimetype,
                fileName: groupAvatar.fileName,
                dataUrl: groupAvatar.dataUrl,
              }
            : undefined,
        }),
      });

      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(data.error || "Error al crear grupo");

      if (data.chat) {
        setChats((prev) => [data.chat as ChatSummary, ...prev]);
      }

      setFilterMode("groups");

      // limpiar modal
      setGroupName("");
      setGroupDescription("");
      setGroupSearch("");
      setGroupSelected([]);
      setGroupAdmins([]);
      setGroupAdminsOnly(false);
      setGroupAvatar(null);
      setShowGroupModal(false);
    } catch (e: any) {
      setGroupError(e.message || "Error al crear grupo");
    } finally {
      setCreatingGroup(false);
    }
  };

  const closeGroupModal = () => {
    if (creatingGroup) return;
    setShowGroupModal(false);
    setGroupError(null);
    setGroupName("");
    setGroupDescription("");
    setGroupSearch("");
    setGroupSelected([]);
    setGroupAdmins([]);
    setGroupAdminsOnly(false);
    setGroupAvatar(null);
  };

  // ====== LAYOUT FULL-SCREEN ======
  return (
    <>
      <div className="h-full w-full flex bg-slate-950 text-slate-100">
        {/* LISTA CHATS */}
        <aside className="w-[280px] h-full border-r border-slate-800 bg-slate-950 flex flex-col">
          <div className="px-4 py-3 border-b border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-sky-400/70">Bandeja</p>
                <p className="text-sm font-semibold text-slate-50">Chats asignados</p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setShowGroupModal(true);
                  setGroupName("");
                  setGroupDescription("");
                  setGroupSearch("");
                  setGroupSelected([]);
                  setGroupAdmins([]);
                  setGroupAdminsOnly(false);
                  setGroupAvatar(null);
                  setGroupError(null);
                }}
                className="inline-flex items-center justify-center rounded-full bg-sky-500/90 px-2.5 py-1 text-[10px] font-semibold text-slate-950 hover:bg-sky-400 transition"
              >
                + Grupo
              </button>
            </div>

            {/* Filtros */}
            <div className="mt-3 flex gap-1">
              <button
                type="button"
                onClick={() => setFilterMode("all")}
                className={`flex-1 rounded-full px-2 py-1 text-[10px] font-medium border ${
                  filterMode === "all"
                    ? "bg-sky-500/20 border-sky-500 text-sky-200"
                    : "bg-slate-900 border-slate-700 text-slate-400 hover:bg-slate-800"
                }`}
              >
                Todos
              </button>
              <button
                type="button"
                onClick={() => setFilterMode("unread")}
                className={`flex-1 rounded-full px-2 py-1 text-[10px] font-medium border ${
                  filterMode === "unread"
                    ? "bg-sky-500/20 border-sky-500 text-sky-200"
                    : "bg-slate-900 border-slate-700 text-slate-400 hover:bg-slate-800"
                }`}
              >
                No leídos
              </button>
              <button
                type="button"
                onClick={() => setFilterMode("groups")}
                className={`flex-1 rounded-full px-2 py-1 text-[10px] font-medium border ${
                  filterMode === "groups"
                    ? "bg-sky-500/20 border-sky-500 text-sky-200"
                    : "bg-slate-900 border-slate-700 text-slate-400 hover:bg-slate-800"
                }`}
              >
                Grupos
              </button>
            </div>

            {/* Buscador */}
            <div className="py-2">
              <input
                className="w-full mt-1 rounded-full bg-slate-900 border border-slate-800 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-sky-500"
                placeholder="Buscar por nombre o número"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingChats && (
              <div className="px-3 py-2 text-[11px] text-slate-400">Cargando chats…</div>
            )}

            {filteredChats.length === 0 && !loadingChats && (
              <div className="px-3 py-4 text-[11px] text-slate-500">No hay chats en esta vista.</div>
            )}

            {filteredChats.map((chat) => {
              const avatarSrc = getAvatarFromChat(chat);
              const displayName = getChatDisplayName(chat);
              const phone = formatPhone(chat.phone ?? null);

              return (
                <button
                  key={chat.id}
                  onClick={() => handleSelectChat(chat)}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs hover:bg-slate-800 ${
                    activeChat?.id === chat.id ? "bg-slate-800" : ""
                  }`}
                >
                  <div className="h-8 w-8 rounded-full bg-slate-800 flex items-center justify-center overflow-hidden text-[11px] font-semibold text-sky-300">
                    {avatarSrc ? (
                      <img src={avatarSrc} alt={displayName} className="h-full w-full object-cover" />
                    ) : (
                      <span>{displayName[0] ?? "?"}</span>
                    )}
                  </div>

                  <div className="flex flex-1 flex-col min-w-0">
                    <span className="truncate text-slate-100 font-medium">{displayName}</span>
                    {phone && <span className="text-[10px] text-slate-500">{phone}</span>}
                    <span className="mt-0.5 line-clamp-1 text-[11px] text-slate-400">{chat.lastMessage}</span>
                  </div>

                  <div className="flex flex-col items-end gap-1">
                    <span className="text-[10px] text-slate-500">
                      {chat.lastMessageAt ? formatTime(chat.lastMessageAt) : ""}
                    </span>
                    {chat.unreadCount ? (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-sky-500 text-[10px] text-white">
                        {chat.unreadCount}
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* PANEL MENSAJES */}
        <section className="flex-1 h-full flex flex-col bg-slate-900">
          {/* header */}
          <header className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-slate-800 flex items-center justify-center overflow-hidden text-xs font-semibold text-sky-300">
                {(() => {
                  const avatar = getAvatarFromChat(activeChat || undefined);
                  if (avatar) {
                    return <img src={avatar} alt={getChatDisplayName(activeChat)} className="h-full w-full object-cover" />;
                  }
                  const headerName = getChatDisplayName(activeChat);
                  return <span>{headerName[0] ?? "?"}</span>;
                })()}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-50">{getChatDisplayName(activeChat)}</p>
                <p className="text-[11px] text-slate-500">{activePhoneFormatted || ""}</p>
              </div>
            </div>

            <div className="text-[11px] text-slate-500 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Conectado
            </div>
          </header>

          {/* mensajes */}
          <section className="flex-1 overflow-y-auto px-4 py-3">
            {error && (
              <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                {error}
              </div>
            )}

            {loadingMessages && messages.length === 0 && (
              <div className="text-[11px] text-slate-400">Cargando mensajes…</div>
            )}

            <div className="flex flex-col gap-1 max-w-4xl mx-auto">
              {messages.map((msg) => {
                const isMine = msg.fromMe;
                const renderedBody = formatMessageBody(msg);

                const digitsOnly = (msg.senderNumber || "")
                  .split("")
                  .filter((ch) => ch >= "0" && ch <= "9")
                  .join("");

                const senderInitial = msg.senderName?.[0] || (digitsOnly ? digitsOnly.slice(-2) : "?");

                return (
                  <div key={msg.id} className={`flex w-full ${isMine ? "justify-end" : "justify-start"}`}>
                    {!isMine && (
                      <div className="mr-2 flex items-end">
                        <div className="h-7 w-7 rounded-full bg-slate-800 flex items-center justify-center overflow-hidden text-[11px] font-semibold text-sky-300">
                          {msg.senderAvatar ? (
                            <img src={msg.senderAvatar} alt={msg.senderName ?? "Contacto"} className="h-full w-full object-cover" />
                          ) : (
                            <span>{senderInitial}</span>
                          )}
                        </div>
                      </div>
                    )}

                    <div
                      className={`relative max-w-[75%] rounded-2xl px-3 py-2 text-[13px] leading-snug shadow-sm ${
                        isMine
                          ? "bg-emerald-500/15 text-slate-50 rounded-br-sm border border-emerald-500/40"
                          : "bg-slate-800 text-slate-50 rounded-bl-sm border border-slate-700"
                      }`}
                    >
                      {msg.media && msg.type === "image" && (
                        <div className="mb-1">
                          <a
                            href={msg.media.dataUrl}
                            download={msg.media.fileName || "imagen.jpg"}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <img
                              src={msg.media.dataUrl}
                              alt={msg.media.fileName || "Imagen"}
                              className="max-h-64 rounded-lg object-cover cursor-pointer"
                            />
                          </a>
                        </div>
                      )}

                      {msg.media && msg.type === "document" && (
                        <a
                          href={msg.media.dataUrl}
                          download={msg.media.fileName || "documento.pdf"}
                          className="mb-1 flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] hover:bg-slate-800"
                        >
                          <span>📄</span>
                          <span className="truncate">{msg.media.fileName || "Documento"}</span>
                          <span className="ml-auto text-[10px] text-slate-400">Descargar</span>
                        </a>
                      )}

                      {msg.media && msg.type === "audio" && (
                        <div className="mb-1">
                          <audio controls src={msg.media.dataUrl} className="w-56 sm:w-64" />
                        </div>
                      )}

                      {msg.media && msg.type && msg.type !== "image" && msg.type !== "document" && msg.type !== "audio" && (
                        <a
                          href={msg.media.dataUrl}
                          download={msg.media.fileName || "archivo"}
                          className="mb-1 flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] hover:bg-slate-800"
                        >
                          <span>📎</span>
                          <span className="truncate">{msg.media.fileName || "Archivo adjunto"}</span>
                          <span className="ml-auto text-[10px] text-slate-400">Descargar</span>
                        </a>
                      )}

                      {renderedBody.trim() && <span className="whitespace-pre-wrap break-words">{renderedBody}</span>}

                      <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-400">
                        <span>{formatTime(msg.timestamp)}</span>
                        {isMine && msg.status && (
                          <span className={msg.status === "read" ? "text-sky-400" : "text-slate-400"}>
                            {getStatusIcon(msg.status)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </section>

          {/* input */}
          <footer className="flex items-center gap-3 px-4 py-3 border-t border-slate-800 bg-slate-900">
            {pendingMedia && (
              <div className="text-[11px] text-slate-300 bg-slate-800 border border-slate-700 rounded px-2 py-1 max-w-xs truncate">
                Archivo listo para enviar: <span className="font-medium">{pendingMedia.fileName || "archivo"}</span>
              </div>
            )}

            <button
              type="button"
              className="hidden sm:inline-flex text-xl text-slate-400 hover:text-slate-100"
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />

            <div className="flex-1">
              <textarea
                className="max-h-24 min-h-[38px] w-full resize-none rounded-2xl bg-slate-950 px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500 outline-none border border-slate-800 focus:border-sky-500"
                placeholder={
                  pendingMedia
                    ? pendingMedia.fileName
                      ? `Mensaje para acompañar "${pendingMedia.fileName}"`
                      : "Escribí un mensaje para acompañar el archivo"
                    : "Escribí un mensaje"
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>

            <button
              type="button"
              onClick={handleSend}
              disabled={(!input.trim() && !pendingMedia) || sending || uploading || !activeChat}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-500 text-base text-slate-950 disabled:opacity-50 shadow-[0_0_20px_rgba(56,189,248,0.5)]"
            >
              ➤
            </button>
          </footer>
        </section>
      </div>

      {/* MODAL CREAR GRUPO */}
      {showGroupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-xl rounded-2xl bg-slate-950 border border-slate-800 shadow-2xl p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-sky-400/70">Nuevo grupo</p>
                <h2 className="text-lg font-semibold text-slate-50">Crear grupo de chats</h2>
              </div>
              <button type="button" onClick={closeGroupModal} className="text-slate-400 hover:text-slate-100 text-sm">
                ✕
              </button>
            </div>

            <div className="flex gap-4 mb-4">
              <div className="flex flex-col items-center gap-2">
                <div className="h-14 w-14 rounded-full bg-slate-800 flex items-center justify-center overflow-hidden">
                  {groupAvatar ? (
                    <img src={groupAvatar.dataUrl} alt={groupAvatar.fileName || "Grupo"} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xl text-slate-300">👥</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => groupAvatarInputRef.current?.click()}
                  className="text-[11px] text-sky-400 hover:text-sky-300"
                >
                  Añadir foto del grupo
                </button>
                <input
                  ref={groupAvatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleGroupAvatarChange}
                />
              </div>

              <div className="flex-1 space-y-2">
                <div>
                  <label className="text-[11px] text-slate-400">Nombre del grupo</label>
                  <input
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-sky-500"
                    placeholder="Ej: Clientes VIP, Equipo Ventas…"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-400">Descripción (opcional)</label>
                  <textarea
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-sky-500 resize-none"
                    rows={2}
                    placeholder="Reglas, info del grupo, etc."
                    value={groupDescription}
                    onChange={(e) => setGroupDescription(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Participantes */}
            <div className="mb-4">
              <p className="text-[11px] font-semibold text-slate-400 mb-1">Participantes (chats individuales)</p>
              <input
                className="w-full rounded-full bg-slate-900 border border-slate-700 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-sky-500 mb-2"
                placeholder="Buscar por nombre o número"
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
              />

              <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/80">
                {chats
                  .filter((c) => !isGroupChat(c))
                  .filter((c) => {
                    const term = groupSearch.trim().toLowerCase();
                    if (!term) return true;
                    const name = getChatDisplayName(c).toLowerCase();
                    const phone = (formatPhone(c.phone ?? null) || "").toLowerCase();
                    return name.includes(term) || phone.includes(term) || (c.name || "").toLowerCase().includes(term);
                  })
                  .map((c) => {
                    const displayName = getChatDisplayName(c);
                    const phone = formatPhone(c.phone ?? null);
                    const avatar = getAvatarFromChat(c);
                    const checked = groupSelected.includes(c.id);
                    const isAdmin = groupAdmins.includes(c.id);

                    return (
                      <div
                        key={c.id}
                        className="flex items-center gap-3 px-3 py-2 text-xs text-slate-100 hover:bg-slate-800/80 cursor-pointer"
                        onClick={() => toggleParticipant(c.id)}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            e.stopPropagation();
                            toggleParticipant(c.id);
                          }}
                          className="h-3 w-3 rounded border-slate-500 bg-slate-900"
                        />
                        <div className="h-7 w-7 rounded-full bg-slate-800 flex items-center justify-center overflow-hidden text-[11px] font-semibold text-sky-300">
                          {avatar ? (
                            <img src={avatar} alt={displayName} className="h-full w-full object-cover" />
                          ) : (
                            <span>{displayName[0] ?? "?"}</span>
                          )}
                        </div>
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="truncate text-[11px]">{displayName}</span>
                          {phone && <span className="text-[10px] text-slate-500">{phone}</span>}
                        </div>
                        <label
                          className="flex items-center gap-1 text-[10px] text-slate-300"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleAdmin(c.id);
                          }}
                        >
                          <input type="checkbox" checked={isAdmin} onChange={() => {}} className="h-3 w-3 rounded border-slate-500 bg-slate-900" />
                          <span>Admin</span>
                        </label>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Permisos de mensajes */}
            <div className="mb-4">
              <p className="text-[11px] font-semibold text-slate-400 mb-1">Permisos de mensajes</p>
              <div className="space-y-1 text-xs text-slate-200">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="msg-permissions"
                    checked={!groupAdminsOnly}
                    onChange={() => setGroupAdminsOnly(false)}
                    className="h-3 w-3"
                  />
                  <span>Todos pueden enviar mensajes</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="msg-permissions"
                    checked={groupAdminsOnly}
                    onChange={() => setGroupAdminsOnly(true)}
                    className="h-3 w-3"
                  />
                  <span>Solo administradores pueden enviar mensajes</span>
                </label>
              </div>
            </div>

            {groupError && (
              <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                {groupError}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={closeGroupModal}
                disabled={creatingGroup}
                className="px-4 py-2 rounded-full border border-slate-700 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleCreateGroup}
                disabled={creatingGroup}
                className="px-4 py-2 rounded-full bg-emerald-500 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
              >
                {creatingGroup ? "Creando..." : "Crear grupo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ========= Página principal del portal ========= */

export default function AgentPortalPage() {
  return (
    <main className="h-screen w-screen m-0 p-0 overflow-hidden">
      <AgentChat />
    </main>
  );
}
