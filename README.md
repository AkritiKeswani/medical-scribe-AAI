<div align="center">

# Realtime Internal Medicine Scribe

**Live clinical dictation → structured SOAP note, generated as the doctor talks.**

[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind](https://img.shields.io/badge/Tailwind-4-38BDF8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![AssemblyAI](https://img.shields.io/badge/AssemblyAI-Universal--Streaming-7C3AED)](https://www.assemblyai.com/docs/speech-to-text/universal-streaming)
[![Gemini](https://img.shields.io/badge/Gemini-2.5%20Flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev)

</div>

---

A browser-first scribe demo: speak naturally during a patient encounter, watch the transcript stream in word-by-word, and watch a structured SOAP note (**S**ubjective / **O**bjective / **A**ssessment / **P**lan + open questions) materialize in real time. When you're done, one click regenerates a clean, consolidated note from the full transcript.

## Features

- **Real-time transcription** via AssemblyAI Universal-Streaming v3 — partial + final turn handling with automatic punctuation and casing
- **Live SOAP patching** — every finalized turn fires a Gemini 2.5 Flash call that incrementally patches the running JSON SOAP note
- **One-click Finalize** — regenerates a clean SOAP note from the full session transcript; drains in-flight live patches first so they can't overwrite the result
- **Secure token brokerage** — the AssemblyAI key stays server-side; the browser only ever sees a short-lived (10-minute) streaming token
- **Race-free updates** — serial Promise queue + state ref keep concurrent LLM calls from clobbering each other
- **No backend state** — entirely in-memory; refresh = clean session

## Architecture

```
┌──────────────────── Browser (app/page.tsx) ─────────────────────┐
│                                                                 │
│   [Mic] → getUserMedia → AudioContext(16 kHz)                   │
│                                │                                │
│                                ▼                                │
│                  ScriptProcessorNode (4096 samples ≈ 256 ms)    │
│                                │  Float32 → Int16 LE PCM        │
│                                ▼                                │
│                  ws.send(pcm16.buffer)  ── binary frames ──┐    │
│                                                            │    │
│   ◀── Turn / Begin / Termination JSON ─────────────────────┤    │
│                                │                           │    │
│   end_of_turn:false  → partial transcript preview          │    │
│   end_of_turn:true   → push chunk + patch SOAP             │    │
│     & turn_is_fmt        via /api/update-soap              │    │
└──────────┬───────────────────────────────────────────┬─────┴────┘
           │ GET /api/token                            │ POST /api/update-soap
           ▼                                           │ POST /api/finalize-soap
  ┌─────────────────┐                                  ▼
  │ Next route      │                         ┌──────────────────┐
  │ mints v3 token  │                         │ Next route       │
  │ (AAI key here)  │                         │ Gemini 2.5 Flash │
  └────────┬────────┘                         └─────────┬────────┘
           ▼                                            ▼
  ┌─────────────────┐                         ┌──────────────────┐
  │ AssemblyAI v3   │                         │  Google Gemini   │
  │ streaming.      │                         │  generativelang. │
  │ assemblyai.com  │                         │  googleapis.com  │
  └─────────────────┘                         └──────────────────┘
```

## Tech stack

| Layer            | Choice                                                   |
|------------------|----------------------------------------------------------|
| Framework        | Next.js 15 (App Router) + React 19                       |
| Language         | TypeScript 5.9                                           |
| Styling          | Tailwind v4 + Radix scroll primitives + Motion           |
| Speech-to-text   | AssemblyAI Universal-Streaming v3 (WebSocket, PCM16)     |
| LLM              | Google Gemini 2.5 Flash (`responseMimeType: "application/json"`) |
| Audio capture    | Web Audio API (`AudioContext` + `ScriptProcessorNode`)   |

## Getting started

### Prerequisites
- Node.js 18+
- An [AssemblyAI](https://www.assemblyai.com/app/account) API key
- A [Google AI Studio / Gemini](https://aistudio.google.com/apikey) API key

### Setup

```bash
# 1. Clone
git clone git@github.com:AkritiKeswani/medical-scribe-AAI.git
cd medical-scribe-AAI

# 2. Install
npm install

# 3. Configure secrets
cp .env.example .env.local
# Edit .env.local and fill in:
#   ASSEMBLYAI_API_KEY=...
#   GEMINI_API_KEY=...

# 4. Run
npm run dev
```

Then open <http://localhost:3000>, click **Start Recording**, and start talking through a mock patient encounter.

## Deploying on Ryvn

Create a **Server** service from this GitHub repository and choose **Dockerfile** as the build method. Use these installation settings:

- Branch: `main`
- Dockerfile: `./Dockerfile`
- Port: `3000`
- Health check path: `/healthz`
- Sensitive environment variables: `ASSEMBLYAI_API_KEY` and `GEMINI_API_KEY`
- Optional environment variable: `APP_URL` set to the public service URL

The image runs as a non-root user, honors Ryvn's runtime `PORT` override, and uses Next.js standalone output. API keys are read only at runtime and are excluded from the Docker build context.

To test the image locally:

```bash
docker build -t medical-scribe .
docker run --rm -p 3000:3000 \
  -e ASSEMBLYAI_API_KEY=your_key \
  -e GEMINI_API_KEY=your_key \
  medical-scribe
```

## Project layout

```
app/
├── api/
│   ├── token/route.ts          # mints short-lived AssemblyAI v3 token
│   ├── update-soap/route.ts    # per-turn incremental SOAP patch (Gemini)
│   └── finalize-soap/route.ts  # full-transcript regeneration (Gemini)
├── globals.css
├── layout.tsx
└── page.tsx                    # the entire UI + audio/WS pipeline
components/ui/                  # ScrollArea, Card, Badge primitives
hooks/use-mobile.ts
lib/utils.ts
```

## How it works end-to-end

1. **Click Start** → frontend `GET /api/token` → server hits `streaming.assemblyai.com/v3/token` with `ASSEMBLYAI_API_KEY` and returns a 10-minute scoped token.
2. **Browser opens WebSocket** to `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&token=…&format_turns=true`.
3. **Mic audio** is captured at 16 kHz, converted Float32 → Int16 LE PCM, and sent as **raw binary frames** (no JSON wrapping, no base64 — that's the v3 contract).
4. **AssemblyAI streams back** `{type:"Turn", transcript, end_of_turn, turn_is_formatted}` messages. Partials update the live preview; the *formatted* final of each turn is committed to `finalizedChunks` and triggers `/api/update-soap`. We deliberately ignore the unformatted final so the LLM only fires once per turn.
5. **Gemini patches** the existing SOAP JSON with the new chunk and returns the whole object. Calls are serialised through a Promise queue so two patches can't race, and a `soapStateRef` mirror keeps each queued call reading the freshest state.
6. **Click Stop** → closes the WS, stops the mic tracks, disposes the AudioContext.
7. **Click Finalize SOAP Note** → `await`s any in-flight patches, then POSTs the joined transcript to `/api/finalize-soap`, which asks Gemini to build a clean SOAP note from scratch — consolidating duplicates and preferring the most recent statement when info is contradicted later in the conversation.

## API routes

| Route                | Method | Body / Query                       | Returns                                          |
|----------------------|--------|------------------------------------|--------------------------------------------------|
| `/api/token`         | GET    | —                                  | `{ token: string }` — 10-min AssemblyAI v3 token |
| `/api/update-soap`   | POST   | `{ currentState, newChunk }`       | Patched SOAP JSON                                |
| `/api/finalize-soap` | POST   | `{ transcript }`                   | Full SOAP JSON regenerated from scratch          |

SOAP JSON shape:

```ts
{
  subjective:      string[],
  objective:       string[],
  assessment:      string[],
  plan:            string[],
  open_questions:  string[],
}
```

## Notes & caveats

- **Demo, not a clinical tool.** No PHI handling, no audit logging, no auth, no persistence. Don't use it with real patient data without adding those.
- **`ScriptProcessorNode` is deprecated** but still works in all major browsers. For production-grade audio, swap it for an `AudioWorkletNode`.
- **LLM output is non-deterministic.** The live patches and the finalize call can produce slightly different results from the same transcript.
- **The AssemblyAI key never reaches the browser** — only the short-lived token does. Treat that token as low-blast-radius (10 min, scoped to streaming).
