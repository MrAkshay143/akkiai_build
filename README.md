# Akki AI - Client Desktop Application

Advanced Agentic Desktop Assistant built with Electron, React, and Gemini Live bidirectional streaming.

## Features

- **Gemini Live Bidirectional Streaming**: Real-time voice and vision interaction.
- **Agent Town**: Autonomous subagent orchestration (Leo, Rancho, Raju, Chatur).
- **Desktop & OS Automation**: System file operations, window management, screen vision, hardware control.
- **Local Neural Media Player**: Embedded media streaming and controls.
- **On-Device Memory Vault**: AI-driven context and memory management (`MEMORY.md`).

## Tech Stack

- **Desktop Framework**: Electron
- **Frontend**: React, Tailwind CSS, Phaser 3, Lucide Icons
- **AI & Integrations**: Google GenAI, Hugging Face, Baileys

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm

### Installation

```bash
npm install
```

### Running

```bash
npx electron .
```

### Building / Packing

To pack the application into an `app.asar` archive:

```bash
npx @electron/asar pack . app.asar
```
