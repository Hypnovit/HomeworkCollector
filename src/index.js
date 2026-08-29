const TG_API = (token) => `https://api.telegram.org/bot${token}/`;
const C = { year: "y", group: "g", name: "n", subject: "sub", topic: "t", folderId: "f", status: "s" };
const CACHE_TTL = 3600;

export default {
    async fetch(request, env, ctx) {
        if (request.method !== "POST") return new Response("OK");

        const update = await request.json();
        if (update.callback_query) {
            ctx.waitUntil(handleCallback(update.callback_query, env));
            return new Response("OK");
        }
        if (update.message) {
            ctx.waitUntil(handleMessage(update.message, env));
            return new Response("OK");
        }
        return new Response("OK");
    }
};

async function handleMessage(message, env) {
    const chatId = message.chat.id;

    if (message.text === "/start" || message.text === "/submit") {
        await sendYearMenu(chatId, null, env.BOT_TOKEN);
        return;
    }

    const status = await env.BOT_CACHE.get(`${chatId}_${C.status}`);
    if (status === "awaiting_file" && !message.document) {
        return tgApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "⚠️ Please send a .doc / .docx / .pdf file.",
            parse_mode: "HTML"
        });
    }

    if (message.document) {
        const { BOT_CACHE, BOT_TOKEN } = env;
        const doc = message.document;
        const fileName = doc.file_name || "";
        const extMatch = fileName.match(/\.[a-zA-Z]+$/);
        if (extMatch && ![".doc", ".docx", ".pdf"].includes(extMatch[0].toLowerCase())) {
            return tgApi(BOT_TOKEN, "sendMessage", {
                chat_id: chatId,
                text: "⚠️ Invalid format. Only .doc / .docx / .pdf accepted.",
                parse_mode: "HTML"
            });
        }

        let processingMsg;
        try {
            processingMsg = await sendMessage(chatId, "Processing your file... ⏳", BOT_TOKEN);
        } catch {
            return;
        }
        const processingId = processingMsg.result.message_id;

        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        const group = await BOT_CACHE.get(`${chatId}_${C.group}`);
        const name = await BOT_CACHE.get(`${chatId}_${C.name}`);
        const subject = await BOT_CACHE.get(`${chatId}_${C.subject}`);
        const topic = await BOT_CACHE.get(`${chatId}_${C.topic}`);
        const folderId = await BOT_CACHE.get(`${chatId}_${C.folderId}`);

        if (!year || !group || !name || !subject || !topic || !folderId) {
            return tgApi(BOT_TOKEN, "sendMessage", {
                chat_id: chatId,
                text: "Missing selections. Please restart with /submit.",
                reply_markup: { inline_keyboard: [[{ text: "Start over", callback_data: "back_to_years" }]] },
                parse_mode: "HTML"
            });
        }

        const payloadToGAS = { chatId, doc, year, group, name, subject, topic, folderId, processingId };

        try {
            // POST to Google Apps Script with manual redirect handling
            let resp = await fetch(env.GAS_WEBAPP_URL, {
                method: "POST",
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(payloadToGAS),
                                   redirect: "manual"
            });

            if (resp.status === 302 || resp.status === 301) {
                const redirectUrl = resp.headers.get("Location");
                if (redirectUrl) {
                    resp = await fetch(redirectUrl, { method: "GET" });
                }
            }

            const body = await resp.text();
            if (body === "ERROR") throw new Error("GAS reported an error");
        } catch (err) {
            console.error("GAS forward error:", err);
            await editKeyboard(
                chatId, processingId,
                "⚠️ The server is currently unavailable. Please try again.",
                BOT_TOKEN,
                [[{ text: "Retry 🔄", callback_data: "retry_submit" }]]
            );
            return;
        }

        await BOT_CACHE.delete(`${chatId}_${C.status}`);
        await BOT_CACHE.delete(`${chatId}_${C.year}`);
        await BOT_CACHE.delete(`${chatId}_${C.group}`);
        await BOT_CACHE.delete(`${chatId}_${C.name}`);
        await BOT_CACHE.delete(`${chatId}_${C.subject}`);
        await BOT_CACHE.delete(`${chatId}_${C.topic}`);
        await BOT_CACHE.delete(`${chatId}_${C.folderId}`);
        return;
    }

    await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "Type /submit to start.",
        reply_markup: { inline_keyboard: [[{ text: "Start here", callback_data: "year_5" }]] },
        parse_mode: "HTML"
    });
}

async function handleCallback(q, env) {
    const chatId = q.message.chat.id;
    const messageId = q.message.message_id;
    const { BOT_CACHE, BOT_TOKEN } = env;
    const data = q.data;

    await fetch(`${TG_API(BOT_TOKEN)}answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: q.id }),
    });

    // 1. Year
    if (data.startsWith("year_")) {
        const year = data.replace("year_", "");
        await BOT_CACHE.put(`${chatId}_${C.year}`, year, { expirationTtl: CACHE_TTL });
        await sendGroupMenu(chatId, messageId, year, env);
        return;
    }

    // 2. Group
    if (data.startsWith("group_")) {
        const group = data.replace("group_", "");
        await BOT_CACHE.put(`${chatId}_${C.group}`, group, { expirationTtl: CACHE_TTL });
        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        await sendNameMenu(chatId, messageId, year, group, env);
        return;
    }

    // 3. Name
    if (data.startsWith("name_")) {
        const name = data.replace("name_", "");
        await BOT_CACHE.put(`${chatId}_${C.name}`, name, { expirationTtl: CACHE_TTL });
        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        const group = await BOT_CACHE.get(`${chatId}_${C.group}`);
        await sendSubjectMenu(chatId, messageId, year, group, name, env);
        return;
    }

    // 4. Subject
    if (data.startsWith("subject_")) {
        const subject = data.replace("subject_", "");
        await BOT_CACHE.put(`${chatId}_${C.subject}`, subject, { expirationTtl: CACHE_TTL });
        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        const group = await BOT_CACHE.get(`${chatId}_${C.group}`);
        const name = await BOT_CACHE.get(`${chatId}_${C.name}`);
        await sendTopicMenu(chatId, messageId, year, group, name, subject, env);
        return;
    }

    // 5. Topic
    if (data.startsWith("topic_")) {
        const topicId = data.replace("topic_", "");
        const { results } = await env.DB.prepare("SELECT topic_name, folder_id FROM topics WHERE id = ?").bind(topicId).all();
        const selectedTopic = results[0];

        await BOT_CACHE.put(`${chatId}_${C.topic}`, selectedTopic.topic_name, { expirationTtl: CACHE_TTL });
        await BOT_CACHE.put(`${chatId}_${C.folderId}`, selectedTopic.folder_id, { expirationTtl: CACHE_TTL });
        await BOT_CACHE.put(`${chatId}_${C.status}`, "awaiting_file", { expirationTtl: CACHE_TTL });

        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        const group = await BOT_CACHE.get(`${chatId}_${C.group}`);
        const name = await BOT_CACHE.get(`${chatId}_${C.name}`);
        const subject = await BOT_CACHE.get(`${chatId}_${C.subject}`);

        const finalPrompt = `<b>Year:</b> ${year}\n<b>Group:</b> ${group}\n<b>Name:</b> ${name}\n<b>Subject:</b> ${subject}\n<b>Topic:</b> ${selectedTopic.topic_name}\n\nPlease upload your .doc / .docx / .pdf file.`;
        await editKeyboard(chatId, messageId, finalPrompt, BOT_TOKEN, [[{ text: "⬅️ Back", callback_data: "back_to_topics" }]]);
        return;
    }

    // Back Navigation
    if (data === "back_to_years") return sendYearMenu(chatId, messageId, BOT_TOKEN);

    if (data === "back_to_groups") {
        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        return sendGroupMenu(chatId, messageId, year, env);
    }

    if (data === "back_to_names") {
        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        const group = await BOT_CACHE.get(`${chatId}_${C.group}`);
        return sendNameMenu(chatId, messageId, year, group, env);
    }

    if (data === "back_to_subjects") {
        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        const group = await BOT_CACHE.get(`${chatId}_${C.group}`);
        const name = await BOT_CACHE.get(`${chatId}_${C.name}`);
        return sendSubjectMenu(chatId, messageId, year, group, name, env);
    }

    if (data === "back_to_topics") {
        const year = await BOT_CACHE.get(`${chatId}_${C.year}`);
        const group = await BOT_CACHE.get(`${chatId}_${C.group}`);
        const name = await BOT_CACHE.get(`${chatId}_${C.name}`);
        const subject = await BOT_CACHE.get(`${chatId}_${C.subject}`);
        return sendTopicMenu(chatId, messageId, year, group, name, subject, env);
    }

    if (data === "retry_submit") {
        await editKeyboard(chatId, messageId, "OK, send your file again.", BOT_TOKEN, []);
        await BOT_CACHE.put(`${chatId}_${C.status}`, "awaiting_file", { expirationTtl: CACHE_TTL });
        return;
    }

    if (data === "say_goodbye") {
        await editKeyboard(chatId, messageId, "Missing you already! Come back soon! 👋", BOT_TOKEN, []);
    }
}

// Menu Generators
function sendYearMenu(chatId, messageId, token) {
    const keyboard = [[{ text: "Year 5", callback_data: "year_5" }]];
    const text = "<b>Step 1.</b> Select your year:";
    return messageId
    ? editKeyboard(chatId, messageId, text, token, keyboard)
    : sendKeyboard(chatId, text, keyboard, token);
}

async function sendGroupMenu(chatId, messageId, year, env) {
    const { results } = await env.DB.prepare("SELECT id FROM groups ORDER BY id").all();
    const keyboard = results.map((g) => [{ text: g.id, callback_data: `group_${g.id}` }]);
    keyboard.push([{ text: "⬅️ Back", callback_data: "back_to_years" }]);
    const text = `<b>Year:</b> ${year}\n\n<b>Step 2.</b> Select your group:`;
    return editKeyboard(chatId, messageId, text, env.BOT_TOKEN, keyboard);
}

async function sendNameMenu(chatId, messageId, year, group, env) {
    const { results } = await env.DB.prepare("SELECT name FROM students WHERE group_id = ? ORDER BY name").bind(group).all();
    const keyboard = results.map((s) => [{ text: s.name, callback_data: `name_${s.name}` }]);
    keyboard.push([{ text: "⬅️ Back", callback_data: "back_to_groups" }]);
    const text = `<b>Year:</b> ${year}\n<b>Group:</b> ${group}\n\n<b>Step 3.</b> Select your name:`;
    return editKeyboard(chatId, messageId, text, env.BOT_TOKEN, keyboard);
}

async function sendSubjectMenu(chatId, messageId, year, group, name, env) {
    const { results } = await env.DB.prepare(
        "SELECT subject_id FROM group_subjects WHERE group_id = ? ORDER BY subject_id"
    ).bind(group).all();

    const keyboard = results.map((s) => [{ text: s.subject_id, callback_data: `subject_${s.subject_id}` }]);
    keyboard.push([{ text: "⬅️ Back", callback_data: "back_to_names" }]);
    const text = `<b>Year:</b> ${year}\n<b>Group:</b> ${group}\n<b>Name:</b> ${name}\n\n<b>Step 4.</b> Select the subject:`;
    return editKeyboard(chatId, messageId, text, env.BOT_TOKEN, keyboard);
}

async function sendTopicMenu(chatId, messageId, year, group, name, subject, env) {
    const { results } = await env.DB.prepare(
        "SELECT id, topic_name FROM topics WHERE subject_id = ? ORDER BY topic_name"
    ).bind(subject).all();

    const keyboard = results.map((t) => [{ text: t.topic_name, callback_data: `topic_${t.id}` }]);
    keyboard.push([{ text: "⬅️ Back", callback_data: "back_to_subjects" }]);
    const text = `<b>Year:</b> ${year}\n<b>Group:</b> ${group}\n<b>Name:</b> ${name}\n<b>Subject:</b> ${subject}\n\n<b>Step 5.</b> Select the topic:`;
    return editKeyboard(chatId, messageId, text, env.BOT_TOKEN, keyboard);
}

async function sendMessage(chatId, text, token) {
    return await (await tgApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" })).json();
}

function sendKeyboard(chatId, text, keyboard, token) {
    return tgApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
}

function editKeyboard(chatId, messageId, text, token, keyboard) {
    return tgApi(token, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
}

async function tgApi(token, method, body) {
    const resp = await fetch(`${TG_API(token)}${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Telegram API ${method} returned ${resp.status}`);
    return resp;
}
