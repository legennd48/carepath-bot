import express from "express";
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_URL = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
const PAYSTACK_LINK = process.env.PAYSTACK_LINK;
const FEEDBACK_LINK = "https://forms.gle/wy45SJqCRxob8dCk7";

// ──────────────────────────────────────────────
// SESSION STORE
// ──────────────────────────────────────────────
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      step: "start",
      data: {},
      timestamps: { sessionStart: new Date().toISOString() },
    };
  }
  return sessions[phone];
}

// ──────────────────────────────────────────────
// WEBHOOK VERIFICATION
// ──────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    return res.status(200).send(challenge);
  }
  console.log("❌ Webhook verification failed");
  return res.sendStatus(403);
});

// ──────────────────────────────────────────────
// INCOMING MESSAGES
// ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    console.log(
      "Raw webhook payload:",
      JSON.stringify(req.body, null, 2)
    );

    if (!value?.messages) {
      console.log("No messages found in webhook payload");
      return;
    }

    const message = value.messages[0];
    const from = message.from;
    const type = message.type;

    let userInput = "";
    if (type === "text") {
      userInput = message.text.body.trim();
    } else if (type === "interactive") {
      userInput =
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id ||
        "";
    } else {
      console.log(`Unsupported message type: ${type}`);
      await sendText(
        from,
        "Please reply with text or tap a button to continue."
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] From ${from} (${type}): "${userInput}"`
    );
    console.log("About to call handleFlow...");
    await handleFlow(from, userInput);
  } catch (error) {
    console.error("Error processing message:", error.message);
  }
});

// ──────────────────────────────────────────────
// ADMIN ENDPOINTS
// ──────────────────────────────────────────────
app.get("/admin/reset/:phone", (req, res) => {
  const phone = req.params.phone;
  delete sessions[phone];
  res.json({ message: `Session reset for ${phone}` });
});

app.get("/admin/session/:phone", (req, res) => {
  const phone = req.params.phone;
  const session = sessions[phone];
  if (!session) return res.json({ message: "No active session" });
  res.json(session);
});

app.get("/admin/sessions", (req, res) => {
  res.json(sessions);
});

app.get("/admin/confirm-payment/:phone", async (req, res) => {
  const phone = req.params.phone;
  const session = sessions[phone];

  if (!session) {
    return res.json({ error: "No session found for this number" });
  }

  if (session.step !== "await_payment") {
    return res.json({
      error: `User is at step "${session.step}", not at payment stage`,
    });
  }

  const d = session.data;

  await sendText(
    phone,
    `Payment confirmed. Thank you ✅\n\n` +
      `Here is your consultation summary:\n\n` +
      `📋 *Symptoms discussed:* ${d.symptom || "N/A"}\n` +
      `📋 *Duration:* ${d.duration || "N/A"}\n` +
      `📋 *Severity:* ${d.severity || "N/A"}\n` +
      `📋 *Recommendation:* A pharmacist would typically recommend ` +
      `a common OTC option for this type of symptom, available at ` +
      `your nearest pharmacy.\n\n` +
      `_⚠️ Note: This is a prototype test. No actual medication ` +
      `recommendation is being made._\n\n` +
      `💊 Your prescription has been sent to our partner pharmacy. ` +
      `You can pick it up or request delivery.\n\n` +
      `Thank you for using CarePath.`
  );

  session.step = "complete";
  session.timestamps.completed = new Date().toISOString();
  res.json({ message: "Post-payment confirmation sent", session });
});

// ──────────────────────────────────────────────
// FLOW STATE MACHINE
// ──────────────────────────────────────────────
async function handleFlow(phone, rawInput) {
  const session = getSession(phone);
  const input = rawInput.toLowerCase();

  switch (session.step) {
    // ── First contact — welcome + intro ────────
    case "start": {
      await sendText(
        phone,
        `👋 *Welcome to CarePath!*\n\n` +
          `CarePath is a health-tech platform being built to give ` +
          `everyday Nigerians instant access to verified pharmacists ` +
          `and doctors — right here on WhatsApp.\n\n` +
          `🏥 *Why are we building this?*\n` +
          `Millions of people self-medicate or avoid care because ` +
          `clinics are far, expensive, or overcrowded. CarePath ` +
          `removes those barriers by letting you consult a licensed ` +
          `health professional from your phone — no app download, ` +
          `no queues, no hassle.\n\n` +
          `🔬 *What's happening right now?*\n` +
          `You're about to experience a prototype of the CarePath ` +
          `consultation flow. We're testing how it feels so we can ` +
          `make it better before launch.\n\n` +
          `Tap the button below when you're ready to proceed.`
      );

      await delay(1500);

      await sendButtonMessage(phone, {
        body:
          `⚠️ *Important — Please read before continuing:*\n\n` +
          `This is a *prototype usability test*. No real medical ` +
          `advice will be given. You will not speak to an actual ` +
          `licensed professional. Any responses you receive are ` +
          `scripted for testing purposes.\n\n` +
          `Please do not make any health decisions based on ` +
          `anything said during this session.\n\n` +
          `Do you understand and agree to proceed?`,
        buttons: [
          { id: "confirm_disclaimer", title: "Yes, I understand" },
        ],
      });
      session.step = "await_disclaimer";
      break;
    }

    // ── Disclaimer confirmation ────────────────
    case "await_disclaimer": {
      if (input === "yes" || input === "confirm_disclaimer") {
        session.timestamps.disclaimerAccepted =
          new Date().toISOString();
        await sendButtonMessage(phone, {
          body:
            `Great! 👋\n\n` +
            `To get started, we need to ask you three quick ` +
            `consent questions. Ready?`,
          buttons: [{ id: "start_consent", title: "Let's go" }],
        });
        session.step = "await_consent_start";
      } else {
        await sendText(
          phone,
          `Please tap the *"Yes, I understand"* button above ` +
            `to continue.`
        );
      }
      break;
    }

    // ── Begin consent ──────────────────────────
    case "await_consent_start": {
      if (input === "let's go" || input === "start_consent") {
        await sendConsent1(phone);
        session.step = "consent_1";
        session.timestamps.consentStarted = new Date().toISOString();
      }
      break;
    }

    // ── Consent 1 ──────────────────────────────
    case "consent_1": {
      if (input === "yes" || input === "consent1_yes") {
        session.timestamps.consent1 = new Date().toISOString();
        await sendConsent2(phone);
        session.step = "consent_2";
      } else {
        await sendText(
          phone,
          `Please tap *"YES, I agree"* to continue.`
        );
      }
      break;
    }

    // ── Consent 2 ──────────────────────────────
    case "consent_2": {
      if (input === "yes" || input === "consent2_yes") {
        session.timestamps.consent2 = new Date().toISOString();
        await sendConsent3(phone);
        session.step = "consent_3";
      } else {
        await sendText(
          phone,
          `Please tap *"YES, I agree"* to continue.`
        );
      }
      break;
    }

    // ── Consent 3 ──────────────────────────────
    case "consent_3": {
      if (input === "yes" || input === "consent3_yes") {
        session.timestamps.consent3 = new Date().toISOString();
        await sendTierSelection(phone);
        session.step = "await_tier";
      } else {
        await sendText(
          phone,
          `Please tap *"YES, I confirm"* to continue.`
        );
      }
      break;
    }

    // ── Tier selection ─────────────────────────
    case "await_tier": {
      if (input === "tier_pharmacist" || input === "1") {
        session.timestamps.tierSelected = new Date().toISOString();
        session.data.tier = "pharmacist";
        await sendText(
          phone,
          `Great. Before we connect you to a pharmacist, ` +
            `please answer a few quick questions so they can ` +
            `help you better.\n\n` +
            `What is your *main symptom* today?\n` +
            `_(e.g. fever, headache, stomach pain, cough)_`
        );
        session.step = "symptom_1";
      } else if (input === "tier_doctor" || input === "2") {
        await sendText(
          phone,
          `The Doctor tier is coming soon. We'll connect you ` +
            `to a Pharmacist for now. 🔜`
        );
        session.data.tier = "pharmacist";
        await sendText(
          phone,
          `What is your *main symptom* today?\n` +
            `_(e.g. fever, headache, stomach pain, cough)_`
        );
        session.step = "symptom_1";
      } else {
        await sendText(
          phone,
          `Please tap one of the buttons above to select.`
        );
      }
      break;
    }

    // ── Symptom intake ─────────────────────────
    case "symptom_1": {
      session.data.symptom = rawInput;
      await sendText(phone, `How long have you had this symptom?`);
      session.step = "symptom_2";
      break;
    }

    case "symptom_2": {
      session.data.duration = rawInput;
      await sendButtonMessage(phone, {
        body: `On a scale of 1 to 3, how severe would you say it is?`,
        buttons: [
          { id: "severity_mild", title: "Mild" },
          { id: "severity_moderate", title: "Moderate" },
          { id: "severity_severe", title: "Severe" },
        ],
      });
      session.step = "symptom_3";
      break;
    }

    case "symptom_3": {
      const severityMap = {
        severity_mild: "Mild",
        severity_moderate: "Moderate",
        severity_severe: "Severe",
        mild: "Mild",
        moderate: "Moderate",
        severe: "Severe",
      };
      session.data.severity = severityMap[input] || rawInput;
      await sendText(
        phone,
        `Have you taken any medication for this already? ` +
          `If yes, what did you take? If none, reply *NO*.`
      );
      session.step = "symptom_4";
      break;
    }

    case "symptom_4": {
      session.data.medication = rawInput;
      await sendText(
        phone,
        `Do you have any known allergies or medical conditions ` +
          `we should know about? If none, reply *NO*.`
      );
      session.step = "symptom_5";
      break;
    }

    case "symptom_5": {
      session.data.allergies = rawInput;
      session.timestamps.intakeCompleted = new Date().toISOString();
      await sendText(
        phone,
        `Thank you. We are connecting you to an available ` +
          `pharmacist now. Please hold on for a moment. ⏳`
      );

      setTimeout(async () => {
        await sendConsultationMessages(phone, session.data);
        session.timestamps.paymentLinkSent =
          new Date().toISOString();

        await delay(3000);

        await sendText(
          phone,
          `🙏 *One last thing!*\n\n` +
            `While you complete your payment, we'd really ` +
            `appreciate your feedback on this experience. ` +
            `It takes less than 2 minutes and helps us build ` +
            `CarePath better for everyone.\n\n` +
            `📝 *Share your feedback here:*\n` +
            `${FEEDBACK_LINK}\n\n` +
            `Thank you for being part of the CarePath ` +
            `prototype test! 💚`
        );

        session.step = "complete";
        session.timestamps.feedbackLinkSent =
          new Date().toISOString();
        session.timestamps.completed = new Date().toISOString();
      }, 4000);
      break;
    }

    // ── Waiting for payment (admin can still confirm) ──
    case "await_payment": {
      await sendText(
        phone,
        `Your consultation summary will be sent once payment ` +
          `is confirmed.\n\nThe payment link is valid for ` +
          `24 hours:\n💳 ${PAYSTACK_LINK}`
      );
      break;
    }

    // ── Flow complete ──────────────────────────
    case "complete": {
      await sendText(
        phone,
        `Your CarePath session is complete. Thank you for ` +
          `participating in our prototype test! 🙏\n\n` +
          `If you haven't yet, please share your feedback:\n` +
          `📝 ${FEEDBACK_LINK}\n\n` +
          `For payment queries, the link is still valid:\n` +
          `💳 ${PAYSTACK_LINK}`
      );
      break;
    }

    default: {
      sessions[phone] = { step: "start", data: {}, timestamps: {} };
      await handleFlow(phone, rawInput);
    }
  }
}

// ──────────────────────────────────────────────
// CONSENT MESSAGE BUILDERS
// ──────────────────────────────────────────────
async function sendConsent1(phone) {
  await sendButtonMessage(phone, {
    body:
      `*1 of 3 — Platform Role*\n\n` +
      `CarePath connects you to licensed health professionals. ` +
      `We are a technology platform, not a hospital or clinic.\n\n` +
      `The professional you speak with will provide guidance — ` +
      `not a clinical diagnosis.\n\n` +
      `Do you understand and agree?`,
    buttons: [{ id: "consent1_yes", title: "YES, I agree" }],
  });
}

async function sendConsent2(phone) {
  await sendButtonMessage(phone, {
    body:
      `*2 of 3 — Your Responsibility*\n\n` +
      `Any decision you make based on the guidance you receive ` +
      `is your own responsibility.\n\n` +
      `The professional and the platform are not liable for ` +
      `actions you choose to take based on this conversation.`,
    buttons: [{ id: "consent2_yes", title: "YES, I agree" }],
  });
}

async function sendConsent3(phone) {
  await sendButtonMessage(phone, {
    body:
      `*3 of 3 — Emergency Notice*\n\n` +
      `⚠️ If your symptoms include:\n` +
      `• Chest pain\n` +
      `• Difficulty breathing\n` +
      `• Loss of consciousness\n` +
      `• Severe bleeding\n\n` +
      `*Stop immediately* and go to the nearest emergency ` +
      `facility or call *112*.`,
    buttons: [{ id: "consent3_yes", title: "YES, I confirm" }],
  });
}

// ──────────────────────────────────────────────
// TIER SELECTION
// ──────────────────────────────────────────────
async function sendTierSelection(phone) {
  await sendButtonMessage(phone, {
    body:
      `Thank you ✅\n\n` +
      `Choose the type of professional you'd like to speak with:`,
    buttons: [
      { id: "tier_pharmacist", title: "Pharmacist — ₦3,500" },
      { id: "tier_doctor", title: "Doctor — ₦6,500" },
    ],
  });
}

// ──────────────────────────────────────────────
// SIMULATED CONSULTATION + PAYMENT PROMPT
// ──────────────────────────────────────────────
async function sendConsultationMessages(phone, data) {
  await sendText(
    phone,
    `Hello, I'm your CarePath pharmacist. I've reviewed your ` +
      `responses. Thank you for sharing.\n\n` +
      `Based on what you've described — *${data.symptom}* ` +
      `lasting *${data.duration}* with *${data.severity}* ` +
      `severity — these are the kinds of things I'd typically ` +
      `discuss with you:\n\n` +
      `• The pattern and duration of your symptoms\n` +
      `• Whether home rest and hydration have helped\n` +
      `• Whether OTC options are appropriate or if you need ` +
      `further evaluation`
  );

  await delay(3000);

  await sendText(
    phone,
    `Based on everything you've shared, this sounds like ` +
      `something that could potentially be managed with the ` +
      `right OTC approach, and I'd like to share a specific ` +
      `recommendation.\n\n` +
      `To receive your *documented consultation summary* and ` +
      `medication recommendation, please complete payment:\n\n` +
      `💳 *Pay ₦3,500 here:*\n${PAYSTACK_LINK}\n\n` +
      `_You have 24 hours to complete this payment._`
  );
}

// ──────────────────────────────────────────────
// LOW-LEVEL SEND HELPERS
// ──────────────────────────────────────────────
async function sendText(phone, text) {
  console.log(`Attempting to send text to ${phone}...`);
  try {
    const response = await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Send success:", response.data);
  } catch (err) {
    console.error(
      `Failed to send text to ${phone}:`,
      err.response?.data || err.message
    );
  }
}

async function sendButtonMessage(phone, { body, buttons }) {
  console.log(`Attempting to send buttons to ${phone}...`);
  const formattedButtons = buttons.map((b) => ({
    type: "reply",
    reply: { id: b.id, title: b.title.slice(0, 20) },
  }));

  try {
    const response = await axios.post(
      GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: { buttons: formattedButtons },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Button send success:", response.data);
  } catch (err) {
    console.error(
      `Failed to send buttons to ${phone}:`,
      err.response?.data || err.message
    );
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "CarePath bot is running",
    activeSessions: Object.keys(sessions).length,
  });
});

// ──────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CarePath bot running on port ${PORT}`);
  console.log(`Phone Number ID: ${PHONE_ID}`);
  console.log(`Graph URL: ${GRAPH_URL}`);
});