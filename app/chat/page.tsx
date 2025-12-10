"use client";

import { useEffect, useRef, useState } from "react";

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

  isGroup?: boolean;

  // número del contacto (solo dígitos o con +)
  phone?: string | null;

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

// helper avatar
const getAvatarFromChat = (
  chat: ChatSummary | null | undefined
): string | null => {
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

/**
 * Texto del mensaje:
 * - Imágenes sin texto: no mostramos "[imagen]" (solo la imagen).
 * - Documentos: mostramos nombre del archivo si no hay texto.
 * - Audio: texto vacío (solo reproductor).
 * - Otros adjuntos: "[adjunto]" si no hay nada.
 * - En grupos, si hay texto, se antepone senderName.
 */
const formatMessageBody = (msg: Message): string => {
  let body = msg.body ?? "";
  const trimmed = body.trim();

  const hasMediaObj = !!msg.media;

  // caso sin texto
  if (!trimmed) {
    if (hasMediaObj) {
      // media presente
      if (msg.type === "image") {
        body = ""; // solo imagen (el componente ya la muestra)
      } else if (msg.type === "document") {
        body = msg.media?.fileName || "📄 Documento";
      } else if (msg.type === "audio") {
        body = ""; // solo reproductor
      } else {
        body = "[adjunto]";
      }
    } else {
      // sin media en el objeto pero con tipo marcado desde backend
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

  // prefijo de nombre para grupos
  if (!msg.fromMe && msg.senderName) {
    const core = body.trim();
    if (!core) {
      body = msg.senderName;
    } else if (
      !core.startsWith(msg.senderName + "\n") &&
      !core.startsWith(msg.senderName + " ")
    ) {
      body = `${msg.senderName}\n${core}`;
    }
  }

  return body;
};

const formatPhone = (raw: string | null): string | null => {
  if (!raw) return null;
  if (raw.startsWith("+")) return raw;
  return `+${raw}`;
};

// Detectar si un chat es grupo aunque no venga isGroup
const isGroupChat = (chat: ChatSummary | null | undefined): boolean => {
  if (!chat) return false;
  if (typeof chat.isGroup === "boolean") return chat.isGroup;
  // fallback: por el id de WhatsApp
  return chat.id.endsWith("@g.us");
};

// Nombre que se va a mostrar en la UI
const getChatDisplayName = (chat: ChatSummary | null | undefined): string => {
  if (!chat) return "Sin chat seleccionado";

  const group = isGroupChat(chat);
  const rawName = (chat.name || "").trim();
  const phoneRaw = (chat.phone as string | null) ?? null;

  if (group) {
    // Si el nombre NO es solo números, lo usamos
    if (rawName && !/^\d+$/.test(rawName)) return rawName;
    // Si viene solo números (tipo 1203...), mostramos algo más amigable
    return rawName || "Grupo sin nombre";
  }

  // Chats individuales
  if (rawName && rawName !== phoneRaw) {
    return rawName;
  }

  if (phoneRaw) {
    return formatPhone(phoneRaw) ?? "Sin nombre";
  }

  return rawName || "Sin nombre";
};

type ChatFilter = "all" | "unread" | "groups";

export default function ChatPage() {
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const firstChatsLoadRef = useRef(true); // 👈 NUEVO, acá arriba

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;

    const { scrollTop, scrollHeight, clientHeight } = el;

    // si está a menos de 80px del fondo, consideramos "abajo"
    const isNearBottom = scrollHeight - (scrollTop + clientHeight) < 80;
    setShouldAutoScroll(isNearBottom);
  };

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChat, setActiveChat] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const [showContactPanel, setShowContactPanel] = useState(false);
  const [editingName, setEditingName] = useState("");
  const [copiedPhone, setCopiedPhone] = useState(false);

  // filtro de lista de chats
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");

  // búsqueda de chats
  const [searchTerm, setSearchTerm] = useState("");

  // último momento en que abriste cada chat (para manejar no leídos)
  const [chatLastSeen, setChatLastSeen] = useState<Record<string, string>>({});

  // emoji picker
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // input de archivos
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // archivo pendiente (como WhatsApp: se adjunta y luego se envía)
  const [pendingMedia, setPendingMedia] = useState<MessageMedia | null>(null);

  // MODAL CREAR GRUPO (versión pro)
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>(
    []
  );
  const [groupMessagesAdminsOnly, setGroupMessagesAdminsOnly] =
    useState(false); // false = todos hablan
  const [groupAdminIds, setGroupAdminIds] = useState<string[]>([]);
  const [creatingGroup, setCreatingGroup] = useState(false);

  // imagen del grupo
  const [groupImage, setGroupImage] = useState<MessageMedia | null>(null);
  const groupImageInputRef = useRef<HTMLInputElement | null>(null);

  // cargar últimos vistos desde localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem("flowcirco_last_seen");
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, string>;
        setChatLastSeen(parsed);
      }
    } catch {
      // ignore
    }
  }, []);

  // guardar en localStorage cuando cambian
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "flowcirco_last_seen",
        JSON.stringify(chatLastSeen)
      );
    } catch {
      // ignore
    }
  }, [chatLastSeen]);

  useEffect(() => {
    if (shouldAutoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, shouldAutoScroll]);

  useEffect(() => {
    if (activeChat) {
      setEditingName(activeChat.name || "");
    } else {
      setEditingName("");
    }
    setShowContactPanel(false);
  }, [activeChat?.id]);

  // ================== cargar chats ==================
  useEffect(() => {
    const fetchChats = async () => {
      try {
        // solo mostramos "Cargando chats…" en la PRIMER carga
        if (firstChatsLoadRef.current) {
          setLoadingChats(true);
        }
        setError(null);

        const res = await fetch("/api/chats", { cache: "no-store" });

        if (!res.ok) {
          console.error("Error /api/chats:", res.status);
          try {
            const txt = await res.text();
            console.error("Body /api/chats:", txt.slice(0, 300));
          } catch (e) {
            console.error("No se pudo leer el body de /api/chats:", e);
          }

          setChats([]);
          return;
        }

        const data = await res.json();

        console.log("CHATS DESDE API:", data.chats);

        const raw: ChatSummary[] = data.chats || [];

        // aplicamos lógica de "leído" usando lastSeen + lastMessageAt
        const normalized = raw.map((c) => {
          let unread = c.unreadCount || 0;
          const lastSeen = c.id && chatLastSeen[c.id];
          if (lastSeen && c.lastMessageAt) {
            if (new Date(c.lastMessageAt) <= new Date(lastSeen)) {
              unread = 0;
            }
          }
          return { ...c, unreadCount: unread };
        });

        setChats(normalized);
        if (!activeChat && normalized.length) {
          setActiveChat(normalized[0]);
        }
      } catch (err: any) {
        console.error("Error fetchChats:", err);
        setChats([]);
      } finally {
        // solo apagamos el loader la PRIMER vez
        if (firstChatsLoadRef.current) {
          setLoadingChats(false);
          firstChatsLoadRef.current = false;
        }
      }
    };

    fetchChats();
    const interval = setInterval(fetchChats, 15000);
    return () => clearInterval(interval);
  }, [chatLastSeen, activeChat?.id]); // 👈 mejor dependemos del id
  // ===============================================================

  // ========= cargar mensajes =========
  useEffect(() => {
    if (!activeChat) return;

    let isFirstLoad = true;
    let cancelled = false;

    const fetchMessages = async () => {
      try {
        if (isFirstLoad) {
          setLoadingMessages(true);
        }
        setError(null);

        const res = await fetch(
          `/api/chats/${encodeURIComponent(activeChat.id)}/messages`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error("Error al cargar mensajes");

        const data = await res.json();
        if (cancelled) return;

        const serverMsgs: Message[] = data.messages || [];

        setMessages((prev) => {
          const byId = new Map<string, Message>();

          // primero los que ya teníamos (incluye media de imágenes, etc.)
          for (const m of prev) {
            byId.set(m.id, m);
          }

          // luego los del server, pero SIN pisar media si viene vacía
          for (const serverMsg of serverMsgs) {
            const existing = byId.get(serverMsg.id);

            if (existing) {
              byId.set(serverMsg.id, {
                ...existing,
                ...serverMsg,
                // si el server no trae media, me quedo con la que ya tenía
                media: serverMsg.media ?? existing.media,
                // idem tipo
                type: serverMsg.type ?? existing.type,
              });
            } else {
              byId.set(serverMsg.id, serverMsg);
            }
          }

          const merged = Array.from(byId.values()).sort(
            (a, b) =>
              new Date(a.timestamp).getTime() -
              new Date(b.timestamp).getTime()
          );

          return merged;
        });

        // 2) Actualizar la info del chat activo en la sidebar
        const listForSummary = serverMsgs.length ? serverMsgs : [];
        if (listForSummary.length) {
          const lastMsg = listForSummary[listForSummary.length - 1];
          const lastIsMine = lastMsg.fromMe;

          let lastBody = lastMsg.body ?? "";
          if (!lastBody.trim()) {
            if (lastMsg.media?.fileName) {
              lastBody = lastMsg.media.fileName;
            } else if (lastMsg.type === "image") {
              lastBody = "📷 Imagen";
            } else if (lastMsg.type === "audio") {
              lastBody = "🎧 Audio";
            } else if (lastMsg.media) {
              lastBody = "📎 Archivo adjunto";
            }
          }

          setChats((prev) =>
            prev.map((c) =>
              c.id === activeChat.id
                ? {
                    ...c,
                    lastMessage: lastBody,
                    lastMessageAt: lastMsg.timestamp,
                    lastMessageFromMe: lastIsMine,
                    lastMessageStatus: lastIsMine ? lastMsg.status : undefined,
                  }
                : c
            )
          );

          setActiveChat((prev) => {
            if (!prev || prev.id !== activeChat.id) return prev;
            return {
              ...prev,
              lastMessage: lastBody,
              lastMessageAt: lastMsg.timestamp,
              lastMessageFromMe: lastIsMine,
              lastMessageStatus: lastIsMine ? lastMsg.status : undefined,
            } as ChatSummary;
          });
        }
      } catch (err: any) {
        console.error(err);
        if (!cancelled) {
          setError(err.message ?? "Error al cargar mensajes");
        }
      } finally {
        if (isFirstLoad && !cancelled) {
          setLoadingMessages(false);
          isFirstLoad = false;
        }
      }
    };

    fetchMessages();
    const interval = setInterval(fetchMessages, 4000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeChat?.id]);
  // ================================================

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

  const sendTextMessage = async (text: string) => {
    if (!text.trim() || !activeChat) return;

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

      const res = await fetch(
        `/api/chats/${encodeURIComponent(activeChat.id)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: optimistic.body }),
        }
      );

      if (!res.ok) {
        const text = await res.text();
        console.error(
          "Error backend /api/chats/[chatId]/messages:",
          res.status,
          text
        );
        throw new Error("Error al enviar mensaje");
      }

      const data = await res.json();
      const saved: Message | undefined = data.message;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId
            ? saved ?? { ...optimistic, status: "sent" }
            : m
        )
      );
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Error al enviar mensaje");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId ? { ...m, status: "pending" } : m
        )
      );
    } finally {
      setSending(false);
    }
  };

  const sendMediaMessage = async (text: string, media: MessageMedia) => {
    if (!activeChat) return;

    const tempId = `temp-file-${Date.now()}`;

    let msgType: MessageType = "media";
    const mt = media.mimetype || "";
    if (mt.startsWith("image/")) msgType = "image";
    else if (mt.startsWith("audio/")) msgType = "audio";
    else if (mt === "application/pdf" || mt.startsWith("application/"))
      msgType = "document";

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

      const res = await fetch(
        `/api/chats/${encodeURIComponent(activeChat.id)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: optimistic.body,
            media,
          }),
        }
      );

      if (!res.ok) {
        const text = await res.text();
        console.error(
          "Error backend /api/chats/[chatId]/messages (media):",
          res.status,
          text
        );
        throw new Error("Error al enviar archivo");
      }

      const data = await res.json();
      const saved: Message | undefined = data.message;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId
            ? saved ?? { ...optimistic, status: "sent" }
            : m
        )
      );
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Error al enviar archivo");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId ? { ...m, status: "pending" } : m
        )
      );
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

  const handleKeyDown = (e: any) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const saveEditedName = () => {
    if (!activeChat) return;
    const newName = editingName.trim() || activeChat.name;
    setActiveChat((prev) =>
      prev && prev.id === activeChat.id ? { ...prev, name: newName } : prev
    );
    setChats((prev) =>
      prev.map((c) => (c.id === activeChat.id ? { ...c, name: newName } : c))
    );
  };

  // teléfono activo: solo en individuales
  const activePhoneRaw =
    activeChat && !isGroupChat(activeChat)
      ? (activeChat.phone as string | null) ?? null
      : null;
  const activePhoneFormatted = formatPhone(activePhoneRaw);

  const handleCopyPhone = async () => {
    if (!activePhoneFormatted) return;
    try {
      await navigator.clipboard?.writeText(activePhoneFormatted);
      setCopiedPhone(true);
      setTimeout(() => setCopiedPhone(false), 1500);
    } catch (e) {
      console.log("No se pudo copiar el teléfono", e);
    }
  };

  const groupMembers =
    isGroupChat(activeChat) && messages.length
      ? (() => {
          const map = new Map<
            string,
            { number: string | null; name: string | null; avatar?: string | null }
          >();

          for (const m of messages) {
            if (m.fromMe) continue;
            const key = m.senderNumber || m.senderName;
            if (!key) continue;

            if (!map.has(key)) {
              map.set(key, {
                number: m.senderNumber ?? null,
                name: m.senderName ?? null,
                avatar: m.senderAvatar ?? null,
              });
            }
          }

          return Array.from(map.values());
        })()
      : [];

  // cuando seleccionás un chat:
  // - lo seteamos como activo
  // - marcamos la hora de "visto" y ponemos unreadCount en 0
  const handleSelectChat = (chat: ChatSummary) => {
    // limpiar mensajes del chat anterior
    setMessages([]);
    setShouldAutoScroll(true);

    setActiveChat(chat);

    const nowIso = new Date().toISOString();

    setChatLastSeen((prev) => ({
      ...prev,
      [chat.id]: nowIso,
    }));

    setChats((prev) =>
      prev.map((c) => (c.id === chat.id ? { ...c, unreadCount: 0 } : c))
    );
  };

  // aplicar filtro + búsqueda a la lista de chats
  const filteredChats = chats.filter((chat) => {
    if (chatFilter === "unread" && (chat.unreadCount || 0) <= 0) {
      return false;
    }
    if (chatFilter === "groups" && !isGroupChat(chat)) {
      return false;
    }

    const term = searchTerm.trim().toLowerCase();
    if (!term) return true;

    const displayName = getChatDisplayName(chat).toLowerCase();
    const phone = (chat.phone || "").toLowerCase();

    return displayName.includes(term) || phone.includes(term);
  });

  const handleEmojiClick = (emoji: string) => {
    setInput((prev) => prev + emoji);
  };

  const handleFileChange = (e: any) => {
    const file: File | undefined = e.target.files?.[0];
    if (!file) return;

    // reseteamos el input para poder volver a elegir el mismo archivo
    e.target.value = "";

    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;

      const mimetype = file.type || "application/octet-stream";

      const mediaPayload: MessageMedia = {
        dataUrl: result, // data:mime;base64,...
        fileName: file.name,
        mimetype,
      };

      // solo lo guardamos pendiente, no se envía todavía
      setPendingMedia(mediaPayload);
    };

    reader.readAsDataURL(file);
  };

  // ==== Helpers CREAR GRUPO PRO ====

  const resetGroupForm = () => {
    setGroupName("");
    setGroupDescription("");
    setGroupSearch("");
    setSelectedParticipantIds([]);
    setGroupMessagesAdminsOnly(false);
    setGroupAdminIds([]);
    setGroupImage(null);
  };

  const toggleParticipant = (chatId: string) => {
    setSelectedParticipantIds((prev) => {
      if (prev.includes(chatId)) {
        // si lo saco como participante, también lo saco de admins
        setGroupAdminIds((prevAdmins) =>
          prevAdmins.filter((id) => id !== chatId)
        );
        return prev.filter((id) => id !== chatId);
      }
      return [...prev, chatId];
    });
  };

  const toggleAdmin = (chatId: string) => {
    setGroupAdminIds((prev) => {
      if (prev.includes(chatId)) {
        return prev.filter((id) => id !== chatId);
      } else {
        // si lo marco como admin y no estaba como participante, lo agrego
        setSelectedParticipantIds((prevSel) =>
          prevSel.includes(chatId) ? prevSel : [...prevSel, chatId]
        );
        return [...prev, chatId];
      }
    });
  };

  const handleGroupImageChange = (e: any) => {
    const file: File | undefined = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;
      setGroupImage({
        dataUrl: result,
        fileName: file.name,
        mimetype: file.type || "image/jpeg",
      });
    };
    reader.readAsDataURL(file);
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim()) {
      setError("El grupo necesita un nombre");
      return;
    }
    if (!selectedParticipantIds.length) {
      setError("Seleccioná al menos 1 participante");
      return;
    }

    // aseguramos que haya admins si se elige "solo admins"
    let adminIdsToSend = groupAdminIds;
    if (groupMessagesAdminsOnly && adminIdsToSend.length === 0) {
      adminIdsToSend = [...selectedParticipantIds];
    }

    // NUMEROS REALES de esos admins
    const adminNumbersRaw = adminIdsToSend
      .map((id) => {
        const c = chats.find((chat) => chat.id === id);
        return c?.phone ?? null;
      })
      .filter((n): n is string => Boolean(n));

    try {
      setCreatingGroup(true);
      setError(null);

      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: groupName.trim(),
          description: groupDescription.trim() || undefined,
          participants: selectedParticipantIds,
          messagesAdminsOnly: groupMessagesAdminsOnly,
          // damos ambas opciones al backend: por id de chat y por número
          adminChatIds: adminIdsToSend,
          adminNumbers: adminNumbersRaw,
          groupImage, // base64 para la foto del grupo (opcional)
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error("Error al crear grupo:", txt);
        throw new Error("Error al crear grupo");
      }

      const data = await res.json();
      const newGroupId: string | undefined = data.groupId;

      // Cerramos modal y limpiamos
      resetGroupForm();
      setShowCreateGroupModal(false);

      // Opcional: refrescar chats y seleccionar el grupo recién creado
      try {
        const resChats = await fetch("/api/chats", { cache: "no-store" });
        if (resChats.ok) {
          const dataChats = await resChats.json();
          const raw: ChatSummary[] = dataChats.chats || [];
          const normalized = raw.map((c: ChatSummary) => {
            let unread = c.unreadCount || 0;
            const lastSeen = c.id && chatLastSeen[c.id];
            if (lastSeen && c.lastMessageAt) {
              if (new Date(c.lastMessageAt) <= new Date(lastSeen)) {
                unread = 0;
              }
            }
            return { ...c, unreadCount: unread };
          });

          setChats(normalized);

          if (newGroupId) {
            const found = normalized.find((c) => c.id === newGroupId);
            if (found) {
              setActiveChat(found);
              setChatFilter("groups");
            }
          }
        }
      } catch (e) {
        console.log(
          "No se pudo refrescar lista de chats después de crear grupo",
          e
        );
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message ?? "Error al crear grupo");
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleOpenCreateGroupModal = () => {
    resetGroupForm();
    setShowCreateGroupModal(true);
  };

  // listas para el modal
  const individualChats = chats.filter((c) => !isGroupChat(c));
  const filteredCandidates = individualChats.filter((chat) => {
    const term = groupSearch.trim().toLowerCase();
    if (!term) return true;
    const phone = (chat.phone || "").toLowerCase();
    const name = (chat.name || "").toLowerCase();
    return name.includes(term) || phone.includes(term);
  });

  return (
    <div className="flex h-screen bg-[#eae6df] text-[#111827]">
      {/* MODAL CREAR GRUPO PRO */}
      {showCreateGroupModal && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-[#e2e8f0] px-4 py-3">
              <h2 className="text-sm font-semibold text-[#111827]">
                Crear grupo
              </h2>
              <button
                className="text-xl leading-none text-[#94a3b8] hover:text-[#111827]"
                onClick={() => {
                  resetGroupForm();
                  setShowCreateGroupModal(false);
                }}
              >
                ×
              </button>
            </div>

            <div className="px-4 py-3 space-y-3">
              {/* Foto de grupo */}
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-[#d4f4e2] flex items-center justify-center overflow-hidden text-2xl text-[#14532d]">
                  {groupImage ? (
                    <img
                      src={groupImage.dataUrl}
                      alt="Foto del grupo"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span>👥</span>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    className="rounded-full border border-[#e2e8f0] px-3 py-1 text-xs text-[#111827] hover:bg-[#f9fafb]"
                    onClick={() => groupImageInputRef.current?.click()}
                  >
                    Añadir foto del grupo
                  </button>
                  {groupImage && (
                    <button
                      type="button"
                      className="self-start text-[11px] text-[#f97316] hover:underline"
                      onClick={() => setGroupImage(null)}
                    >
                      Quitar foto
                    </button>
                  )}
                </div>

                <input
                  ref={groupImageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleGroupImageChange}
                />
              </div>

              <div>
                <label className="text-xs font-medium text-[#64748b]">
                  Nombre del grupo
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm outline-none focus:border-[#22c55e]"
                  placeholder="Ej: Clientes VIP, Equipo Ventas..."
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </div>

              <div>
                <label className="text-xs font-medium text-[#64748b]">
                  Descripción (opcional)
                </label>
                <textarea
                  className="mt-1 w-full rounded-lg border border-[#e2e8f0] px-3 py-2 text-xs outline-none focus:border-[#22c55e] min-h-[60px] resize-none"
                  placeholder="Reglas, info del grupo, etc."
                  value={groupDescription}
                  onChange={(e) => setGroupDescription(e.target.value)}
                />
              </div>

              <div>
                <p className="text-xs font-medium text-[#64748b] mb-1">
                  Participantes (chats individuales)
                </p>
                <input
                  className="w-full rounded-lg border border-[#e2e8f0] bg-[#f9fafb] px-3 py-2 text-xs outline-none focus:border-[#22c55e]"
                  placeholder="Buscar por nombre o número"
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                />
              </div>

              <div className="max-h-56 overflow-y-auto rounded-lg border border-[#e2e8f0]">
                {filteredCandidates.length === 0 && (
                  <div className="px-3 py-2 text-xs text-[#94a3b8]">
                    No se encontraron chats.
                  </div>
                )}

                {filteredCandidates.map((chat) => {
                  const avatarSrc = getAvatarFromChat(chat);
                  const phone = formatPhone(
                    (chat.phone as string | null) ?? null
                  );
                  const isSelected = selectedParticipantIds.includes(chat.id);
                  const isAdmin = groupAdminIds.includes(chat.id);

                  return (
                    <div
                      key={chat.id}
                      className="flex items-center justify-between px-3 py-2 text-xs hover:bg-[#f0f2f5]"
                    >
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => toggleParticipant(chat.id)}
                          className="h-4 w-4 rounded border border-[#cbd5f1] flex items-center justify-center bg-white"
                        >
                          {isSelected && <span>✓</span>}
                        </button>

                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-[#d4f4e2] flex items-center justify-center overflow-hidden text-[11px] font-semibold text-[#14532d]">
                            {avatarSrc ? (
                              <img
                                src={avatarSrc}
                                alt={chat.name}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <span>{chat.name?.[0] ?? "?"}</span>
                            )}
                          </div>
                          <div className="flex flex-col">
                            <span className="font-medium text-[#111827]">
                              {chat.name}
                            </span>
                            {phone && (
                              <span className="text-[11px] text-[#94a3b8]">
                                {phone}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <label className="flex items-center gap-1 text-[11px] text-[#64748b]">
                          <input
                            type="checkbox"
                            className="h-3 w-3"
                            checked={isAdmin}
                            onChange={() => toggleAdmin(chat.id)}
                          />
                          Admin
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-2 border-t border-[#e2e8f0] pt-2">
                <p className="text-xs font-medium text-[#64748b] mb-1">
                  Permisos de mensajes
                </p>
                <div className="flex flex-col gap-1 text-xs text-[#111827]">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={!groupMessagesAdminsOnly}
                      onChange={() => setGroupMessagesAdminsOnly(false)}
                    />
                    <span>Todos pueden enviar mensajes</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={groupMessagesAdminsOnly}
                      onChange={() => setGroupMessagesAdminsOnly(true)}
                    />
                    <span>Solo administradores pueden enviar mensajes</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[#e2e8f0] px-4 py-3">
              <button
                type="button"
                className="rounded-full border border-[#e2e8f0] px-4 py-1.5 text-xs text-[#64748b] hover:bg-[#f9fafb]"
                onClick={() => {
                  resetGroupForm();
                  setShowCreateGroupModal(false);
                }}
                disabled={creatingGroup}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="rounded-full bg-[#00a884] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                onClick={handleCreateGroup}
                disabled={creatingGroup}
              >
                {creatingGroup ? "Creando..." : "Crear grupo"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SIDEBAR */}
      <aside className="hidden lg:flex w-[380px] flex-col bg-white border-r border-[#e2e8f0]">
        <header className="flex items-center justify-between px-4 py-3 bg-[#f0f2f5] border-b border-[#e2e8f0]">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-emerald-500 flex items-center justify-center text-sm font-semibold text-white">
              F
            </div>
            <div>
              <p className="text-sm font-semibold text-[#111827]">
                Flow Circo CRM
              </p>
              <p className="text-xs text-[#64748b]">Conectado</p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleOpenCreateGroupModal}
            className="rounded-full bg-[#00a884] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#059669]"
          >
            + Grupo
          </button>
        </header>

        <div className="px-3 py-2 bg_white">
          <input
            className="w-full rounded-full bg-[#f0f2f5] border border-[#e2e8f0] px-3 py-2 text-sm text-[#111827] placeholder:text-[#9ca3af] outline-none"
            placeholder="Buscar chat"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Filtros */}
        <div className="px-3 pt-1 pb-2 bg-white flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => setChatFilter("all")}
            className={`rounded-full px-3 py-1 border text-[11px] ${
              chatFilter === "all"
                ? "bg-[#00a884] border-[#00a884] text-white"
                : "bg-white border-[#e2e8f0] text-[#64748b]"
            }`}
          >
            Todos
          </button>
          <button
            type="button"
            onClick={() => setChatFilter("unread")}
            className={`rounded-full px-3 py-1 border text-[11px] ${
              chatFilter === "unread"
                ? "bg-[#00a884] border-[#00a884] text-white"
                : "bg-white border-[#e2e8f0] text-[#64748b]"
            }`}
          >
            No leídos
          </button>
          <button
            type="button"
            onClick={() => setChatFilter("groups")}
            className={`rounded-full px-3 py-1 border text-[11px] ${
              chatFilter === "groups"
                ? "bg-[#00a884] border-[#00a884] text-white"
                : "bg-white border-[#e2e8f0] text-[#64748b]"
            }`}
          >
            Grupos
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-white">
          {loadingChats && (
            <div className="px-3 py-2 text-xs text-[#64748b]">
              Cargando chats…
            </div>
          )}

          {filteredChats.map((chat) => {
            const avatarSrc = getAvatarFromChat(chat);
            const displayName = getChatDisplayName(chat);

            return (
              <button
                key={chat.id}
                onClick={() => handleSelectChat(chat)}
                className={`flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-[#f0f2f5] ${
                  activeChat?.id === chat.id ? "bg-[#e5effa]" : ""
                }`}
              >
                <div className="relative">
                  <div className="h-10 w-10 rounded-full bg-[#d4f4e2] flex items-center justify-center overflow-hidden">
                    {avatarSrc ? (
                      <img
                        src={avatarSrc}
                        alt={displayName}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-xs font-semibold text-[#14532d]">
                        {displayName[0] ?? "?"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-1 items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate text-[#111827]">
                      {displayName}
                    </p>
                    <p className="text-xs text-[#64748b] truncate flex items-center gap-1">
                      {chat.lastMessageFromMe && chat.lastMessageStatus && (
                        <span
                          className={`text-[11px] ${
                            chat.lastMessageStatus === "read"
                              ? "text-[#0ea5e9]"
                              : "text-[#64748b]"
                          }`}
                        >
                          {getStatusIcon(
                            chat.lastMessageStatus as MessageStatus
                          )}
                        </span>
                      )}
                      <span className="truncate">{chat.lastMessage}</span>
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-[11px] text-[#94a3b8]">
                      {chat.lastMessageAt ? formatTime(chat.lastMessageAt) : ""}
                    </span>
                    {chat.unreadCount ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] text-white">
                        {chat.unreadCount}
                      </span>
                    ) : null}
                  </div>
                </div>
              </button>
            );
          })}

          {!loadingChats && !filteredChats.length && (
            <div className="px-3 py-4 text-xs text-[#64748b]">
              No hay chats todavía.
            </div>
          )}
        </div>
      </aside>

      {/* PANEL DERECHO */}
      <main className="flex flex-1 flex-col bg-[#efeae2]">
        {/* Header chat */}
        <header className="flex items-center justify-between px-4 py-3 bg-[#f0f2f5] border-l border-[#e2e8f0]">
          <div
            className="flex items-center gap-3 cursor-pointer"
            onClick={() =>
              activeChat && setShowContactPanel((prev) => !prev)
            }
          >
            <div className="h-8 w-8 rounded-full bg-[#d4f4e2] flex items-center justify-center overflow-hidden">
              {(() => {
                const avatar = getAvatarFromChat(activeChat || undefined);
                if (avatar) {
                  return (
                    <img
                      src={avatar}
                      alt={getChatDisplayName(activeChat)}
                      className="h-full w-full object-cover"
                    />
                  );
                }
                const headerName = getChatDisplayName(activeChat);
                return (
                  <span className="text-sm font-semibold text-[#14532d]">
                    {headerName[0] ?? "?"}
                  </span>
                );
              })()}
            </div>
            <div>
              <p className="text-sm font-semibold text-[#111827]">
                {getChatDisplayName(activeChat)}
              </p>
              <p className="text-xs text-[#64748b]">
                {activeChat ? "en línea" : ""}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 text-[#94a3b8] text-xl">
            <span>🔍</span>
            <span>⋮</span>
          </div>
        </header>

        {/* Ficha contacto/grupo */}
        {activeChat && showContactPanel && (
          <div className="border-b border-[#e2e8f0] bg-white px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-full bg-[#d4f4e2] flex items-center justify-center overflow-hidden">
                {(() => {
                  const avatar = getAvatarFromChat(activeChat || undefined);
                  if (avatar) {
                    return (
                      <img
                        src={avatar}
                        alt={getChatDisplayName(activeChat)}
                        className="h-full w-full object-cover"
                      />
                    );
                  }
                  const headerName = getChatDisplayName(activeChat);
                  return (
                    <span className="text-sm font-semibold text-[#14532d]">
                      {headerName[0] ?? "?"}
                    </span>
                  );
                })()}
              </div>

              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <input
                    className="bg-transparent border-none outline-none p-0 m-0 text-sm font-semibold text-[#111827]"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={saveEditedName}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveEditedName();
                      }
                    }}
                  />
                  {isGroupChat(activeChat) && (
                    <span className="rounded-full bg-[#e5effa] px-2 py-[1px] text-[10px] font-medium text-[#1d4ed8] uppercase tracking-wide">
                      Grupo
                    </span>
                  )}
                </div>

                {!isGroupChat(activeChat) && activePhoneFormatted && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-[#64748b]">
                    <span>{activePhoneFormatted}</span>
                    <button
                      type="button"
                      onClick={handleCopyPhone}
                      className="rounded-full border border-[#e2e8f0] px-2 py-[2px] text-[11px] hover:bg-[#f0f2f5]"
                    >
                      📋 Copiar
                    </button>
                    {copiedPhone && (
                      <span className="text-[10px] text-[#22c55e]">
                        Copiado
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {isGroupChat(activeChat) && groupMembers.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold text-[#64748b] mb-1">
                  Miembros del grupo (por últimos mensajes)
                </p>
                <div className="flex flex-wrap gap-2">
                  {groupMembers.map((m, idx) => {
                    const displayName = m.name || m.number || "Desconocido";
                    const displayPhone = m.number
                      ? formatPhone(m.number)
                      : null;
                    const initial = (displayName || "?")[0];

                    return (
                      <div
                        key={`${displayName}-${displayPhone ?? idx}`}
                        className="flex items-center gap-2 rounded-full bg-[#f0f2f5] px-2.5 py-1"
                      >
                        <div className="h-6 w-6 rounded-full bg-[#d4f4e2] flex items-center justify-center overflow-hidden text-[10px] font-semibold text-[#14532d]">
                          {m.avatar ? (
                            <img
                              src={m.avatar}
                              alt={displayName}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span>{initial}</span>
                          )}
                        </div>
                        <div className="text-[11px] leading-tight text-[#111827] max-w-[140px]">
                          <div className="font-medium truncate">
                            {displayName}
                          </div>
                          {displayPhone && (
                            <div className="text-[#64748b]">
                              {displayPhone}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Mensajes */}
        <section
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
          className="flex-1 overflow-y-auto px-4 py-4"
          style={{
            backgroundImage:
              'url("https://static.whatsapp.net/rsrc.php/v3/yP/r/rYZqPCBaG70.png")',
            backgroundColor: "#efeae2",
            backgroundBlendMode: "soft-light",
          }}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-1">
            {error && (
              <div className="mb-2 rounded bg-red-100 px-3 py-2 text-xs text-red-700 border border-red-200">
                {error}
              </div>
            )}

            {loadingMessages && messages.length === 0 && (
              <div className="mb-2 text-center text-xs text-[#64748b]">
                Cargando mensajes…
              </div>
            )}

            {messages.map((msg) => {
              const isMine = msg.fromMe;

              const digitsOnly = (msg.senderNumber || "")
                .split("")
                .filter((ch) => ch >= "0" && ch <= "9")
                .join("");

              const senderInitial =
                msg.senderName?.[0] ||
                (digitsOnly ? digitsOnly.slice(-2) : "?");

              const renderedBody = formatMessageBody(msg);

              return (
                <div
                  key={msg.id}
                  className={`flex w-full ${
                    isMine ? "justify-end" : "justify-start"
                  }`}
                >
                  {!isMine && (
                    <div className="mr-2 flex items-end">
                      <div className="h-7 w-7 rounded-full bg-[#d4f4e2] flex items-center justify-center overflow-hidden text-[11px] font-semibold text-[#14532d]">
                        {msg.senderAvatar ? (
                          <img
                            src={msg.senderAvatar}
                            alt={msg.senderName ?? "Contacto"}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span>{senderInitial}</span>
                        )}
                      </div>
                    </div>
                  )}

                  <div
                    className={`relative max-w-[75%] rounded-lg px-2.5 py-1.5 text-sm leading-snug shadow-sm ${
                      isMine
                        ? "bg-[#d9fdd3] text-[#111827] rounded-br-sm"
                        : "bg-[#ffffff] text-[#111827] rounded-bl-sm"
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
                            className="max-h-64 rounded-md object-cover cursor-pointer"
                          />
                        </a>
                      </div>
                    )}

                    {msg.media && msg.type === "document" && (
                      <a
                        href={msg.media.dataUrl}
                        download={msg.media.fileName || "documento.pdf"}
                        className="mb-1 flex items-center gap-2 rounded-md border border-[#e2e8f0] bg-[#f9fafb] px-2 py-1 text-xs hover:bg-[#eef2ff]"
                      >
                        <span>📄</span>
                        <span className="truncate">
                          {msg.media.fileName || "Documento"}
                        </span>
                        <span className="ml-auto text-[10px] text-[#64748b]">
                          Descargar
                        </span>
                      </a>
                    )}

                    {msg.media && msg.type === "audio" && (
                      <div className="mb-1">
                        <audio
                          controls
                          src={msg.media.dataUrl}
                          className="w-56 sm:w-64"
                        />
                      </div>
                    )}

                    {msg.media &&
                      msg.type &&
                      msg.type !== "image" &&
                      msg.type !== "document" &&
                      msg.type !== "audio" && (
                        <a
                          href={msg.media.dataUrl}
                          download={msg.media.fileName || "archivo"}
                          className="mb-1 flex items-center gap-2 rounded-md border border-[#e2e8f0] bg-[#f9fafb] px-2 py-1 text-xs hover:bg-[#eef2ff]"
                        >
                          <span>📎</span>
                          <span className="truncate">
                            {msg.media.fileName || "Archivo adjunto"}
                          </span>
                          <span className="ml-auto text-[10px] text-[#64748b]">
                            Descargar
                          </span>
                        </a>
                      )}

                    {renderedBody.trim() && (
                      <span className="whitespace-pre-wrap break-words">
                        {renderedBody}
                      </span>
                    )}

                    <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[#64748b]">
                      <span>{formatTime(msg.timestamp)}</span>
                      {isMine && msg.status && (
                        <span
                          className={`ml-1 text-[11px] ${
                            msg.status === "read"
                              ? "text-[#0ea5e9]"
                              : "text-[#64748b]"
                          }`}
                        >
                          {getStatusIcon(msg.status)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            <div ref={bottomRef} />
          </div>
        </section>

        {/* Input */}
        <footer className="relative flex items-center gap-3 px-4 py-3 bg-[#f0f2f5] border-t border-[#e2e8f0]">
          {showEmojiPicker && (
            <div className="absolute bottom-14 left-4 z-20 w-64 rounded-lg border border-[#e2e8f0] bg-white shadow-lg p-2 grid grid-cols-8 gap-1 text-xl">
              {[
                "😀",
                "😁",
                "😂",
                "🤣",
                "😊",
                "😍",
                "😘",
                "😎",
                "😇",
                "🙂",
                "🙃",
                "🤔",
                "😅",
                "😢",
                "😭",
                "😡",
                "👍",
                "👎",
                "🙏",
                "🔥",
                "💰",
                "🎰",
                "🎉",
                "✅",
              ].map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => handleEmojiClick(em)}
                  className="rounded hover:bg-[#f0f2f5]"
                >
                  {em}
                </button>
              ))}
            </div>
          )}

          {pendingMedia && (
            <div className="absolute left-16 bottom-12 text-xs text-[#64748b] bg-white border border-[#e2e8f0] rounded px-2 py-1 shadow-sm max-w-xs truncate">
              Archivo listo para enviar:{" "}
              <span className="font-medium">
                {pendingMedia.fileName || "archivo"}
              </span>
            </div>
          )}

          <button
            type="button"
            className="text-2xl text-[#94a3b8] hover:text-[#111827]"
            onClick={() => setShowEmojiPicker((prev) => !prev)}
          >
            😊
          </button>

          <button
            type="button"
            className="hidden sm:inline-flex text-2xl text-[#94a3b8] hover:text-[#111827]"
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>

          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
          />

          <div className="flex-1">
            <textarea
              className="max-h-32 min-h-[40px] w-full resize-none rounded-lg bg-white px-3 py-2 text-sm text-[#111827] placeholder:text-[#9ca3af] outline-none border border-[#d1d5db] focus:border-[#22c55e]"
              placeholder={
                pendingMedia
                  ? pendingMedia.fileName
                    ? `Mensaje para acompañar "${pendingMedia.fileName}"`
                    : "Escribe un mensaje para acompañar el archivo"
                  : "Escribe un mensaje"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={
              (!input.trim() && !pendingMedia) ||
              sending ||
              uploading ||
              !activeChat
            }
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#00a884] text-xl text-white disabled:opacity-60"
          >
            ➤
          </button>
        </footer>
      </main>
    </div>
  );
}