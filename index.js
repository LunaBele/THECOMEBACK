const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const bodyParser = require("body-parser");
const path = require("path");
const WebSocket = require("ws");
const cron = require("node-cron");
const config = require("./config.json");

const app = express();
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ====== REGISTRATION MESSAGE CACHE ======
const unregisteredMessageCache = new Map(); // Stores { uid: timestamp }
const MESSAGE_COOLDOWN = 5 * 60 * 1000; // 5 minutes in milliseconds

// ====== DB SETUP ======
mongoose.connect(config.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const userSchema = new mongoose.Schema({
  uid: { type: String, unique: true },
  name: String,
  seeds: [String],
  gear: [String],
  eggs: [String],
  travelingmerchant: [String],
  lastNotified: { type: Map, of: Number, default: {} },
});

const User = mongoose.model("User", userSchema);

// ====== FACEBOOK MESSENGER API ======
async function sendMessengerMessage(uid, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: uid },
        message,
      },
      { timeout: 5000 } // 5-second timeout
    );
  } catch (err) {
    console.error("Messenger Send Error:", {
      uid,
      error: err.response?.data?.error || err.message,
      status: err.response?.status,
    });
  }
}

async function sendRegistrationMessage(uid) {
  // Check if message was sent recently
  const lastSent = unregisteredMessageCache.get(uid);
  if (lastSent && Date.now() - lastSent < MESSAGE_COOLDOWN) {
    return; // Don't send if within cooldown
  }

  // Validate UID format (numeric string)
  if (!/^\d+$/.test(uid)) {
    console.error(`Invalid UID format in sendRegistrationMessage: ${uid}`);
    return;
  }

  await sendMessengerMessage(uid, {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements: [
          {
            title: "Register to Use GAG DROP WATCH",
            subtitle: `Copy your UID: ${uid}`,
            buttons: [
              {
                type: "postback",
                title: "Copy UID",
                payload: `COPY_UID_${uid}`,
              },
              {
                type: "web_url",
                url: config.WEB_INTERFACE_URL,
                title: "Register Now",
              },
            ],
          },
        ],
      },
    },
  });

  // Update cache
  unregisteredMessageCache.set(uid, Date.now());
}

// ====== WEBSOCKET SETUP ======
let ws;
let stockData = null;
let keepAliveInterval = null;

function formatValue(val) {
  if (val >= 1_000_000) return `x${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `x${(val / 1_000).toFixed(1)}K`;
  return `x${val}`;
}

function getManilaTime() {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: true,
  });
}

function connectWebSocket() {
  ws = new WebSocket("wss://gagstock.gleeze.com");

  ws.on("open", () => {
    console.log("WebSocket connected");
    keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("ping");
      }
    }, 10000);
  });

  ws.on("message", (data) => {
    try {
      const payload = JSON.parse(data);
      if (payload.status !== "success" || !payload.data) {
        console.error("Invalid WebSocket data");
        return;
      }
      stockData = payload.data;
      console.log("Received stock data:", stockData);
    } catch (err) {
      console.error("WebSocket Message Error:", err.message);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket Error:", err.message);
    stockData = null;
  });

  ws.on("close", () => {
    console.log("WebSocket closed, reconnecting in 3 seconds...");
    clearInterval(keepAliveInterval);
    stockData = null;
    setTimeout(connectWebSocket, 3000);
  });
}

// Initialize WebSocket connection
connectWebSocket();

// ====== CRON JOB FOR AUTOMATIC NOTIFICATIONS ======
cron.schedule("0,5,10,15,20,25,30,35,40,45,50,55 * * * *", async () => {
  if (!stockData) {
    console.log("No stock data for cron job");
    return;
  }

  try {
    const users = await User.find({});
    for (const user of users) {
      const inStockItems = [];
      const lastNotified = user.lastNotified || new Map();

      // Check seeds
      if (user.seeds && user.seeds.length > 0 && stockData.seed?.items) {
        stockData.seed.items.forEach(item => {
          if (user.seeds.includes(item.name) && item.quantity > 0) {
            const lastSent = lastNotified.get(item.name) || 0;
            if (Date.now() - lastSent > 24 * 60 * 60 * 1000) {
              inStockItems.push(`${item.emoji} ${item.name}: ${formatValue(item.quantity)}`);
              lastNotified.set(item.name, Date.now());
            }
          }
        });
      }

      // Check gear
      if (user.gear && user.gear.length > 0 && stockData.gear?.items) {
        stockData.gear.items.forEach(item => {
          if (user.gear.includes(item.name) && item.quantity > 0) {
            const lastSent = lastNotified.get(item.name) || 0;
            if (Date.now() - lastSent > 24 * 60 * 60 * 1000) {
              inStockItems.push(`${item.emoji} ${item.name}: ${formatValue(item.quantity)}`);
              lastNotified.set(item.name, Date.now());
            }
          }
        });
      }

      // Check eggs
      if (user.eggs && user.eggs.length > 0 && stockData.egg?.items) {
        stockData.egg.items.forEach(item => {
          if (user.eggs.includes(item.name) && item.quantity > 0) {
            const lastSent = lastNotified.get(item.name) || 0;
            if (Date.now() - lastSent > 24 * 60 * 60 * 1000) {
              inStockItems.push(`${item.emoji} ${item.name}: ${formatValue(item.quantity)}`);
              lastNotified.set(item.name, Date.now());
            }
          }
        });
      }

      // Check traveling merchant
      if (user.travelingmerchant && user.travelingmerchant.length > 0 && stockData.travelingmerchant?.items) {
        stockData.travelingmerchant.items.forEach(item => {
          if (user.travelingmerchant.includes(item.name) && item.quantity > 0) {
            const lastSent = lastNotified.get(item.name) || 0;
            if (Date.now() - lastSent > 24 * 60 * 60 * 1000) {
              inStockItems.push(`${item.emoji} ${item.name}: ${formatValue(item.quantity)}`);
              lastNotified.set(item.name, Date.now());
            }
          }
        });
      }

      if (inStockItems.length > 0) {
        const timestamp = getManilaTime();
        const notifyMsg = `📦 Alert for ${user.name} at ${timestamp}:\n\n` +
                          `Your preferred items are in stock:\n${inStockItems.join("\n")}\n\n` +
                          `Check GAG DROP WATCH for more details!`;
        await sendMessengerMessage(user.uid, { text: notifyMsg });

        // Update lastNotified in database
        await User.updateOne({ uid: user.uid }, { lastNotified });
      }
    }
  } catch (err) {
    console.error("Cron Job Error:", err.message);
  }
});

// ====== PERSISTENT MENU ======
async function setupPersistentMenu() {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messenger_profile?access_token=${config.PAGE_ACCESS_TOKEN}`,
      {
        persistent_menu: [
          {
            locale: "default",
            composer_input_disabled: false,
            call_to_actions: [
              {
                type: "postback",
                title: "Check Stock",
                payload: "CHECK_STOCK",
              },
              {
                type: "postback",
                title: "View Preferences",
                payload: "VIEW_PREFERENCES",
              },
            ],
          },
        ],
      }
    );
    console.log("Persistent menu set up successfully.");
  } catch (err) {
    console.error("Persistent Menu Setup Error:", {
      error: err.response?.data?.error || err.message,
      status: err.response?.status,
    });
  }
}

// Call setupPersistentMenu when server starts
setupPersistentMenu();

// ====== COMMAND HANDLING ======
async function handleAdminCommands(uid, messageText) {
  if (uid !== config.ADMIN_UID) {
    await sendMessengerMessage(uid, { text: "You are not authorized to use admin commands." });
    return false;
  }

  const args = messageText.trim().split(/\s+/);
  const command = args[0].toLowerCase();
  const subCommand = args[1]?.toLowerCase();

  if (command === "database") {
    if (subCommand === "-show") {
      try {
        const users = await User.find({}).sort({ name: 1 });
        if (users.length === 0) {
          await sendMessengerMessage(uid, { text: "No users found in the database." });
          return true;
        }
        const userList = users.map(user => `UID: ${user.uid}, Name: ${user.name}`).join("\n");
        await sendMessengerMessage(uid, { text: `📋 Database Users (Alphabetical by Name):\n\n${userList}` });
        return true;
      } catch (err) {
        console.error("Database -show Error:", err.message);
        await sendMessengerMessage(uid, { text: "Failed to retrieve user list." });
        return true;
      }
    } else if (subCommand === "-delete" && args[2]) {
      const targetUid = args[2];
      try {
        const user = await User.findOneAndDelete({ uid: targetUid });
        if (user) {
          await sendMessengerMessage(uid, { text: `✅ User ${user.name} (UID: ${targetUid}) deleted successfully.` });
        } else {
          await sendMessengerMessage(uid, { text: `User with UID ${targetUid} not found.` });
        }
        return true;
      } catch (err) {
        console.error("Database -delete Error:", err.message);
        await sendMessengerMessage(uid, { text: "Failed to delete user." });
        return true;
      }
    }
  } else if (command === "message") {
    if (subCommand === "-global" && args.length > 2) {
      const message = args.slice(2).join(" ");
      try {
        const users = await User.find({});
        for (const user of users) {
          await sendMessengerMessage(user.uid, { text: `📢 Admin Broadcast: ${message}` });
        }
        await sendMessengerMessage(uid, { text: `✅ Broadcast sent to ${users.length} users.` });
        return true;
      } catch (err) {
        console.error("Message -global Error:", err.message);
        await sendMessengerMessage(uid, { text: "Failed to send broadcast." });
        return true;
      }
    } else if (args[1] && args.length > 2) {
      const targetUid = args[1];
      const message = args.slice(2).join(" ");
      try {
        const user = await User.findOne({ uid: targetUid });
        if (user) {
          await sendMessengerMessage(targetUid, { text: `📩 Admin Message: ${message}` });
          await sendMessengerMessage(uid, { text: `✅ Message sent to ${user.name} (UID: ${targetUid}).` });
        } else {
          await sendMessengerMessage(uid, { text: `User with UID ${targetUid} not found.` });
        }
        return true;
      } catch (err) {
        console.error("Message Error:", err.message);
        await sendMessengerMessage(uid, { text: "Failed to send message." });
        return true;
      }
    }
  } else if (command === "adminhelp") {
    const helpMsg = `📋 Admin Commands:\n\n` +
                    `Database -show: Show all user IDs and names (alphabetical).\n` +
                    `Database -delete [id]: Delete a user by their UID.\n` +
                    `Message -global [message]: Send a message to all users.\n` +
                    `Message [id] [message]: Send a message to a specific user.\n` +
                    `AdminHelp: Show this list.`;
    await sendMessengerMessage(uid, { text: helpMsg });
    return true;
  }

  return false; // Command not recognized
}

async function handleMemberCommands(uid, messageText, user) {
  const command = messageText.trim().toLowerCase();

  if (command === "stock") {
    await handleStockCheck(uid);
    return true;
  } else if (command === "preference") {
    const prefsMsg = `✅ Your Grow A Garden preferences:\n\n` +
                     `🌱 Seeds: ${user.seeds.join(", ") || "None"}\n` +
                     `🛠️ Gear: ${user.gear.join(", ") || "None"}\n` +
                     `🥚 Eggs: ${user.eggs.join(", ") || "None"}\n` +
                     `🚚 Traveling Merchant: ${user.travelingmerchant.join(", ") || "None"}\n\n` +
                     `To update, visit the web interface.`;
    await sendMessengerMessage(uid, { text: prefsMsg });
    return true;
  } else if (command === "uid") {
    const uidMsg = `Your UID: ${uid}\n\n` +
                   `Visit ${config.WEB_INTERFACE_URL} to update your preferences.`;
    await sendMessengerMessage(uid, { text: uidMsg });
    return true;
  } else if (command === "help") {
    const helpMsg = `📋 Available Commands:\n\n` +
                    `Stock: Show the latest stock list.\n` +
                    `Preference: Show your saved preferences.\n` +
                    `Uid: Show your UID and the website URL.\n` +
                    `Help: Show this list.`;
    await sendMessengerMessage(uid, { text: helpMsg });
    return true;
  }

  return false; // Command not recognized
}

// ====== WEBHOOK HANDLING ======
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging[0];
      const uid = webhookEvent.sender.id;

      // Validate UID format
      if (!/^\d+$/.test(uid)) {
        console.error(`Invalid UID format in webhook: ${uid}`);
        res.status(200).json({ status: "success" });
        continue;
      }

      // Check if user is registered
      const user = await User.findOne({ uid });
      if (!user) {
        await sendRegistrationMessage(uid);
        res.status(200).json({ status: "success" });
        continue; // Skip further processing for unregistered users
      }

      // Handle text message
      if (webhookEvent.message && webhookEvent.message.text) {
        const messageText = webhookEvent.message.text.trim();

        // Try admin commands first (if user is admin)
        if (uid === config.ADMIN_UID) {
          const handled = await handleAdminCommands(uid, messageText);
          if (handled) {
            res.status(200).json({ status: "success" });
            continue;
          }
        }

        // Try member commands
        const handled = await handleMemberCommands(uid, messageText, user);
        if (!handled) {
          await sendMessengerMessage(uid, {
            text: "Unknown command. Type 'Help' for a list of available commands.",
          });
        }
      }

      // Handle postback (e.g., menu options or Copy UID)
      if (webhookEvent.postback) {
        const payload = webhookEvent.postback.payload;
        if (payload === "CHECK_STOCK") {
          await handleStockCheck(uid);
        } else if (payload === "VIEW_PREFERENCES") {
          const prefsMsg = `✅ Your Grow A Garden preferences:\n\n` +
                           `🌱 Seeds: ${user.seeds.join(", ") || "None"}\n` +
                           `🛠️ Gear: ${user.gear.join(", ") || "None"}\n` +
                           `🥚 Eggs: ${user.eggs.join(", ") || "None"}\n` +
                           `🚚 Traveling Merchant: ${user.travelingmerchant.join(", ") || "None"}\n\n` +
                           `To update, visit the web interface.`;
          await sendMessengerMessage(uid, { text: prefsMsg });
        } else if (payload.startsWith("COPY_UID_")) {
          const copiedUid = payload.replace("COPY_UID_", "");
          // Validate UID format before sending
          if (/^\d+$/.test(copiedUid)) {
            await sendMessengerMessage(copiedUid, { text: copiedUid });
          } else {
            console.error(`Invalid UID format in COPY_UID postback: ${copiedUid}`);
            await sendMessengerMessage(uid, { text: "Error: Invalid UID format. Please try again." });
          }
        }
      }
    }

    res.status(200).json({ status: "success" });
  } else {
    res.sendStatus(404);
  }
});

// Stock check handler
async function handleStockCheck(uid) {
  const user = await User.findOne({ uid });
  if (!user) {
    await sendRegistrationMessage(uid);
    return;
  }

  if (!stockData) {
    await sendMessengerMessage(uid, { text: "Stock data unavailable. Please try again later." });
    return;
  }

  try {
    const sections = [];

    // Collect all in-stock items
    if (stockData.seed?.items) {
      const items = stockData.seed.items.filter(i => i.quantity > 0);
      if (items.length > 0) {
        sections.push(`🌱 Seeds:\n${items.map(i => `${i.emoji} ${i.name}: ${formatValue(i.quantity)}`).join("\n")}`);
      }
    }

    if (stockData.gear?.items) {
      const items = stockData.gear.items.filter(i => i.quantity > 0);
      if (items.length > 0) {
        sections.push(`🛠️ Gear:\n${items.map(i => `${i.emoji} ${i.name}: ${formatValue(i.quantity)}`).join("\n")}`);
      }
    }

    if (stockData.egg?.items) {
      const items = stockData.egg.items.filter(i => i.quantity > 0);
      if (items.length > 0) {
        sections.push(`🥚 Eggs:\n${items.map(i => `${i.emoji} ${i.name}: ${formatValue(i.quantity)}`).join("\n")}`);
      }
    }

    if (stockData.travelingmerchant?.items) {
      const items = stockData.travelingmerchant.items.filter(i => i.quantity > 0);
      if (items.length > 0) {
        sections.push(`🚚 Traveling Merchant:\n${items.map(i => `${i.emoji} ${i.name}: ${formatValue(i.quantity)}`).join("\n")}`);
      }
    }

    if (stockData.cosmetics?.items) {
      const items = stockData.cosmetics.items.filter(i => i.quantity > 0);
      if (items.length > 0) {
        sections.push(`🎨 Cosmetics:\n${items.map(i => `${i.name}: ${formatValue(i.quantity)}`).join("\n")}`);
      }
    }

    if (stockData.honey?.items) {
      const items = stockData.honey.items.filter(i => i.quantity > 0);
      if (items.length > 0) {
        sections.push(`🎉 Event (Honey):\n${items.map(i => `${i.name}: ${formatValue(i.quantity)}`).join("\n")}`);
      }
    }

    const timestamp = getManilaTime();
    let stockMsg = `📦 Stock Check for ${user.name} at ${timestamp}:\n\n`;
    if (sections.length > 0) {
      stockMsg += `${sections.join("\n\n")}\n\nCheck GAG DROP WATCH for more details!`;
    } else {
      stockMsg += `No items currently in stock.\n\nCheck GAG DROP WATCH for updates!`;
    }

    await sendMessengerMessage(uid, { text: stockMsg });
  } catch (err) {
    console.error("Stock Check Error:", err.message);
    await sendMessengerMessage(uid, { text: "Failed to check stock. Please try again later." });
  }
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Check UID (basic validation, no Facebook API)
app.post("/check-uid", async (req, res) => {
  const { uid } = req.body;
  const trimmedUid = uid.trim();

  // Validate UID format (numeric string)
  if (!/^\d+$/.test(trimmedUid)) {
    return res.json({ success: false, message: "Invalid UID format. Please enter a numeric UID." });
  }

  const user = await User.findOne({ uid: trimmedUid });
  if (user) {
    return res.json({
      success: true,
      name: user.name,
      mode: "edit",
      seeds: user.seeds,
      gear: user.gear,
      eggs: user.eggs,
      travelingmerchant: user.travelingmerchant,
    });
  }

  res.json({ success: true, mode: "new" });
});

// Save preferences
app.post("/save-preferences", async (req, res) => {
  const { uid, name, seeds, gear, eggs, travelingmerchant } = req.body;

  try {
    const trimmedUid = uid.trim();
    const trimmedName = name.trim();

    // Validate inputs
    if (!/^\d+$/.test(trimmedUid)) {
      return res.status(400).json({ success: false, message: "Invalid UID format. Please enter a numeric UID." });
    }
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: "Name is required." });
    }
    if (!seeds.length && !gear.length && !eggs.length && !travelingmerchant.length) {
      return res.status(400).json({ success: false, message: "Please select at least one preference." });
    }

    const user = await User.findOne({ uid: trimmedUid });
    const mode = user ? "Edit Mode" : "New";
    const updatedUser = await User.findOneAndUpdate(
      { uid: trimmedUid },
      { name: trimmedName, seeds, gear, eggs, travelingmerchant },
      { new: true, upsert: true }
    );

    // Clear registration message cache for this user
    unregisteredMessageCache.delete(trimmedUid);

    // Send Messenger confirmation
    let notifyMsg = `✅ Hi ${updatedUser.name}! You have successfully registered with GAG DROP WATCH (${mode}).\n\n` +
                    `🌱 Seeds: ${updatedUser.seeds.join(", ") || "None"}\n` +
                    `🛠️ Gear: ${updatedUser.gear.join(", ") || "None"}\n` +
                    `🥚 Eggs: ${updatedUser.eggs.join(", ") || "None"}\n` +
                    `🚚 Traveling Merchant: ${updatedUser.travelingmerchant.join(", ") || "None"}\n\n` +
                    `You will be notified when these items are in stock.`;
    await sendMessengerMessage(trimmedUid, { text: notifyMsg });

    res.json({ success: true, message: "Preferences saved and confirmation sent on Messenger." });
  } catch (err) {
    console.error("Save Error:", err.message);
    res.status(500).json({ success: false, message: "Failed to save preferences. Please try again." });
  }
});

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));