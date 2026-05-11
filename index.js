const BOT_TOKEN = "8678528147:AAF9EfX9xDbNl-O9crQBoeWqvChzj7UYfM0";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    const update = await request.json();

    if (update.callback_query) {
      return await handleCallback(update.callback_query, env);
    }

    if (!update.message) return new Response("OK");

    const msg = update.message;
    const chatId = msg.chat.id.toString();
    const text = msg.text || "";
    
    // Config: ADMIN_LIST should be a comma-separated string of IDs in Secrets
    const ownerId = env.OWNER_ID;
    const adminList = env.ADMIN_LIST ? env.ADMIN_LIST.split(",") : [];
    const staff = [ownerId, ...adminList];

    const isAdmin = staff.includes(chatId);

    // --- 1. WELCOME MESSAGE (/start) ---
    if (text === "/start") {
      await env.USERS.put(chatId, "active");
      const welcome = `<b>🚀 FROM MOCK MATRIX HUB SUPPORT</b>\n\n` +
                      `Greetings! We are glad to have you here. ✨\n\n` +
                      `<b>📜 RULES & STEPS:</b>\n` +
                      `1️⃣ Send your query/file directly here.\n` +
                      `2️⃣ Our team will review it shortly.\n` +
                      `3️⃣ Do not spam; wait for a response.\n\n` +
                      `<b>🕒 REPLY TIME:</b>\n` +
                      `Usually within 1-2 hours. 🙏`;
      return await sendTelegram("sendMessage", { chat_id: chatId, text: welcome, parse_mode: "HTML" });
    }

    // --- 2. STATUS COMMAND ---
    if (isAdmin && text === "/status") {
      const userList = await env.USERS.list();
      const actualUsers = userList.keys.filter(k => !k.name.includes("_"));
      const statusMsg = `📊 <b>BOT STATISTICS</b>\n\n` +
                        `👤 <b>Total Users:</b> ${actualUsers.length}\n` +
                        `🛡️ <b>Total Staff:</b> ${staff.length}\n` +
                        `🚀 <b>Mode:</b> Multi-Admin Forward Sync`;
      return await sendTelegram("sendMessage", { chat_id: chatId, text: statusMsg, parse_mode: "HTML" });
    }

    // --- 3. MULTI-MESSAGE BROADCAST INITIATION ---
    if (isAdmin && text === "/broadcast") {
      await env.USERS.put(`state_${chatId}`, "waiting_for_bc", { expirationTtl: 3600 });
      await env.USERS.delete(`queue_${chatId}`);
      return await sendTelegram("sendMessage", { chat_id: chatId, text: "📢 <b>Broadcast Mode</b>\nSend all messages/files you want to broadcast. Send <b>/done</b> when finished.", parse_mode: "HTML"});
    }

    const state = await env.USERS.get(`state_${chatId}`);
    if (isAdmin && state === "waiting_for_bc") {
      if (text === "/done") {
        await env.USERS.put(`state_${chatId}`, "confirm_bc");
        return await sendTelegram("sendMessage", {
          chat_id: chatId,
          text: "⚠️ <b>Confirm Broadcast</b>\nSend these collected messages to all users?",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Yes, Start", callback_data: `bc_yes_0_0_0` },
              { text: "❌ No, Cancel", callback_data: `bc_no` }
            ]]
          }
        });
      }
      let queue = await env.USERS.get(`queue_${chatId}`);
      queue = queue ? JSON.parse(queue) : [];
      queue.push(msg);
      await env.USERS.put(`queue_${chatId}`, JSON.stringify(queue), { expirationTtl: 3600 });
      return new Response("OK");
    }

    // --- 4. FORWARDING (User -> All Staff) ---
    if (!isAdmin) {
      await env.USERS.put(chatId, "active");
      for (const staffId of staff) {
        const fwd = await sendTelegram("forwardMessage", {
          chat_id: staffId,
          from_chat_id: chatId,
          message_id: msg.message_id
        });
        const fwdData = await fwd.json();
        if (fwdData.ok) {
          await env.USERS.put(`msg_${staffId}_${fwdData.result.message_id}`, chatId, { expirationTtl: 172800 });
        }
      }
      return new Response("OK");
    }

        // --- 5. REPLYING & SYNCING (Admin -> User & Other Staff) ---
    if (isAdmin && msg.reply_to_message) {
      const targetId = await env.USERS.get(`msg_${chatId}_${msg.reply_to_message.message_id}`);
      
      if (targetId) {
        // A. Send the reply to the actual User
        await sendTelegram("copyMessage", {
          chat_id: targetId,
          from_chat_id: chatId,
          message_id: msg.message_id
        });

        // B. Sync this reply to ALL other Staff with a QUOTE link
        for (const staffId of staff) {
          if (staffId === chatId) continue; 

          // Find the specific forwarded message for this user in this staff member's chat
          const staffKeys = await env.USERS.list({ prefix: `msg_${staffId}_` });
          let linkedMsgId = null;

          for (const key of staffKeys.keys) {
            const storedUser = await env.USERS.get(key.name);
            if (storedUser === targetId) {
              linkedMsgId = key.name.split("_")[2];
              // We keep the loop going to find the MOST RECENT message from that user
            }
          }

          // Send the sync message as a Quoted Reply
          await sendTelegram("copyMessage", {
            chat_id: staffId,
            from_chat_id: chatId,
            message_id: msg.message_id,
            reply_to_message_id: linkedMsgId // THIS LINE CREATES THE QUOTE BUBBLE
          });
        }
      }
      return new Response("OK");
    }

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id.toString();
  
  if (cb.data === "bc_no") {
    await env.USERS.delete(`queue_${chatId}`);
    await env.USERS.delete(`state_${chatId}`);
    return await sendTelegram("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: "❌ Broadcast Cancelled." });
  }

  if (cb.data.startsWith("bc_yes_")) {
    const parts = cb.data.split("_");
    let startIndex = parseInt(parts[2]);
    let successTotal = parseInt(parts[3]);
    let blockedTotal = parseInt(parts[4]);

    const queueData = await env.USERS.get(`queue_${chatId}`);
    if (!queueData) return new Response("OK");
    const queue = JSON.parse(queueData);
    
    const userList = await env.USERS.list();
    const allUsers = userList.keys.filter(k => !k.name.includes("_"));
    
    const batchSize = 40;
    const endIndex = Math.min(startIndex + batchSize, allUsers.length);
    const currentBatch = allUsers.slice(startIndex, endIndex);

    await sendTelegram("editMessageText", { 
      chat_id: chatId, 
      message_id: cb.message.message_id, 
      text: `🚀 <b>Broadcasting...</b>\nProcessing: ${startIndex + 1} to ${endIndex} of ${allUsers.length}`,
      parse_mode: "HTML"
    });

    for (const userKey of currentBatch) {
      let userBlocked = false;
      await new Promise(r => setTimeout(r, 100)); // 100ms Timeout per user for stability

      for (const bcMsg of queue) {
        const res = await sendTelegram("copyMessage", { 
          chat_id: userKey.name, 
          from_chat_id: chatId, 
          message_id: bcMsg.message_id 
        });
        const resJson = await res.json();
        if (!resJson.ok && resJson.error_code === 403) {
          userBlocked = true;
          break; 
        }
      }
      if (userBlocked) blockedTotal++; else successTotal++;
    }

    if (endIndex < allUsers.length) {
      return await sendTelegram("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: `📊 <b>Batch Status</b>\nProgress: ${endIndex}/${allUsers.length}\n\n✅ Sent: ${successTotal}\n🚫 Blocked: ${blockedTotal}`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "➡️ Send to Remaining", callback_data: `bc_yes_${endIndex}_${successTotal}_${blockedTotal}` }]]
        }
      });
    } else {
      await env.USERS.delete(`queue_${chatId}`);
      await env.USERS.delete(`state_${chatId}`);
      return await sendTelegram("editMessageText", { 
        chat_id: chatId, 
        message_id: cb.message.message_id, 
        text: `✅ <b>Broadcast Complete!</b>\n\n👤 Unique Users: ${allUsers.length}\n✅ Successful: ${successTotal}\n🚫 Blocked: ${blockedTotal}`,
        parse_mode: "HTML"
      });
    }
  }
}

async function sendTelegram(method, body) {
  return await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
