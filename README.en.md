# Kizuna Pro — Comprehensive Technical Whitepaper & Engineering Documentation

<p align="left">
  <a href="./README.md">简体中文 (README.md)</a> | <strong>English</strong>
</p>

> An enterprise-grade, ultra-humanlike QQ AI Agent all-in-one system engineered for Windows desktops and remote Linux servers.  
> Deeply integrates the **NapCat (OneBot v11)** protocol gateway, the **DeepSeek Harness (DSH)** isolated plugin-based inference host, our in-house **qq-bridge** humanlike cognitive scheduling kernel, and an **Electron / Web** visual operations & orchestration console.

---

## Table of Contents

- [1. System Architecture Overview](#1-system-architecture-overview)
  - [1.1 Process Topology & Plane Separation](#11-process-topology--plane-separation)
  - [1.2 End-to-End Message & Single-Turn Collapse Sequence](#12-end-to-end-message--single-turn-collapse-sequence)
- [2. Deep Dive into the Four Core Subsystems](#2-deep-dive-into-the-four-core-subsystems)
  - [2.1 Visual Management Console (Orchestrator & Antigravity-Style Ops Center)](#21-visual-management-console-orchestrator--antigravity-style-ops-center)
  - [2.2 NapCat Protocol Gateway (OneBot v11)](#22-napcat-protocol-gateway-onebot-v11)
  - [2.3 In-House qq-bridge Cognitive Scheduling Hub (Business Brain)](#23-in-house-qq-bridge-cognitive-scheduling-hub-business-brain)
  - [2.4 DeepSeek Harness Isolated Runtime (Inference Host & Unified Reasoning Effort)](#24-deepseek-harness-isolated-runtime-inference-host--unified-reasoning-effort)
- [3. Permanent Single-Session Single-Turn Collapse Architecture & Pure Snake-Case Prompt Engineering](#3-permanent-single-session-single-turn-collapse-architecture--pure-snake-case-prompt-engineering)
  - [3.1 Paradigm Shift: From Multi-Turn Snowballing to Permanent Single-Session + Physical Single-Turn Collapse (`collapseToSingleTurn`)](#31-paradigm-shift-from-multi-turn-snowballing-to-permanent-single-session--physical-single-turn-collapse-collapsetosingleturn)
  - [3.2 Zero-Chinese, Zero-Sample-Pollution Pure Lowercase Snake-Case Prompt Specification](#32-zero-chinese-zero-sample-pollution-pure-lowercase-snake-case-prompt-specification)
- [3.3 Full-Dimensional Action Architecture: Single-Turn Batch Dispatch (Unified Text & Memes) & Autonomous Perception](#33-full-dimensional-action-architecture-single-turn-batch-dispatch-unified-text--memes--autonomous-perception)
  - [3.4 Orthogonal Dual-Track Persona System: Single-File `.md` Persona Deck vs. Built-In Character Skill Library](#34-orthogonal-dual-track-persona-system-single-file-md-persona-deck-vs-built-in-character-skill-library)
  - [3.5 Adaptive Group Velocity Window, Context-Aware Smart Targeting & Bidirectional Social Bond Graph](#35-adaptive-group-velocity-window-context-aware-smart-targeting--bidirectional-social-bond-graph)
  - [3.6 Context-Driven Proactive Reply Backoff (`waiting-peer-reply`)](#36-context-driven-proactive-reply-backoff-waiting-peer-reply)
  - [3.7 Architectural Evolution & Quantitative Comparison (Before vs. After)](#37-architectural-evolution--quantitative-comparison-before-vs-after)
- [4. Hybrid Semantic Memory (`bge-small-zh-v1.5` ONNX + FTS5 RRF), Incremental Profile Reconciliation & Slang Co-Occurrence Promotion](#4-hybrid-semantic-memory-bge-small-zh-v15-onnx--fts5-rrf-incremental-profile-reconciliation--slang-co-occurrence-promotion)
  - [4.1 Three-Tier SQLite Memory Architecture & Pre-Collapse Asynchronous Micro-Fact Extraction](#41-three-tier-sqlite-memory-architecture--pre-collapse-asynchronous-micro-fact-extraction)
  - [4.2 Offline Local Embedding Model (`bge-small-zh-v1.5` 512d Int8 ONNX) + FTS5 Trigram Hybrid RRF Retrieval](#42-offline-local-embedding-model-bge-small-zh-v15-512d-int8-onnx--fts5-trigram-hybrid-rrf-retrieval)
  - [4.3 Frozen System Layer + Dynamic Per-Turn Wake Slot (`buildDynamicTurnContext`)](#43-frozen-system-layer--dynamic-per-turn-wake-slot-builddynamicturncontext)
  - [4.4 Incremental Profile Reconciliation & Group Chat Anti-Pollution](#44-incremental-profile-reconciliation--group-chat-anti-pollution)
  - [4.5 Multi-User Slang Co-Occurrence Auto-Promotion & Background Learning Stream](#45-multi-user-slang-co-occurrence-auto-promotion--background-learning-stream)
  - [4.6 Strict Isolation Between Local and Remote Server Databases](#46-strict-isolation-between-local-and-remote-server-databases)
- [5. Complete Panorama of 101 MCP Extension Tools](#5-complete-panorama-of-101-mcp-extension-tools)
  - [5.1 Status, Time & Runtime Inspection (5 Tools)](#51-status-time--runtime-inspection-5-tools)
  - [5.2 Group & Session Management (4 Tools)](#52-group--session-management-4-tools)
  - [5.3 Message Dispatch & Interaction (7 Tools)](#53-message-dispatch--interaction-7-tools)
  - [5.4 Message Reading & History Retrieval (8 Tools)](#54-message-reading--history-retrieval-8-tools)
  - [5.5 Wake Control, Closure & Waiting (3 Tools)](#55-wake-control-closure--waiting-3-tools)
  - [5.6 Long-Term Memory & Group Slang (8 Tools)](#56-long-term-memory--group-slang-8-tools)
  - [5.7 Persona Learning & Character Library Control (8 Tools)](#57-persona-learning--character-library-control-8-tools)
  - [5.8 Member Profiles, Relationships & Access Control (7 Tools)](#58-member-profiles-relationships--access-control-7-tools)
  - [5.9 Images, Stickers & Meme Gallery Ecosystem (13 Tools)](#59-images-stickers--meme-gallery-ecosystem-13-tools)
  - [5.10 Voice Synthesis, ASR, File Parsing & Word Documents (4 Tools)](#510-voice-synthesis-asr-file-parsing--word-documents-4-tools)
  - [5.11 Rich Cards, Merged Forwards & Video Parsing (4 Tools)](#511-rich-cards-merged-forwards--video-parsing-4-tools)
  - [5.12 Web Media Search, Pixiv & Music (4 Tools)](#512-web-media-search-pixiv--music-4-tools)
  - [5.13 Qzone Feeds & Social Interactions (5 Tools)](#513-qzone-feeds--social-interactions-5-tools)
  - [5.14 Scheduled Reminders & Cron Tasks (3 Tools)](#514-scheduled-reminders--cron-tasks-3-tools)
  - [5.15 Cross-Session Messaging (2 Tools)](#515-cross-session-messaging-2-tools)
  - [5.16 Runtime Dynamic Configuration & Voice Management (9 Tools)](#516-runtime-dynamic-configuration--voice-management-9-tools)
  - [5.17 MCP Host Service Tools (5 Tools)](#517-mcp-host-service-tools-5-tools)
  - [5.18 MCP Safe Web Search Service (2 Tools)](#518-mcp-safe-web-search-service-2-tools)
  - [5.19 Three-Layer Token Optimization: `slimTools`, `mcp-compressor` Proxy & Single-Turn Collapse](#519-three-layer-token-optimization-slimtools-mcp-compressor-proxy--single-turn-collapse)
- [6. Multimedia & Signature Capabilities](#6-multimedia--signature-capabilities)
- [6.0 Photography-Grade High-Fidelity Vision, QQ MarketFace Resolution & Temperature 1.0 Lock](#60-photography-grade-high-fidelity-vision-qq-marketface-resolution--temperature-10-lock)
  - [6.1 22-Platform Concurrent Federated Web Search & SSRF Sandbox](#61-22-platform-concurrent-federated-web-search--ssrf-sandbox)
  - [6.2 Original-Resolution Pixiv Artwork Delivery & Integrity Verification](#62-original-resolution-pixiv-artwork-delivery--integrity-verification)
  - [6.3 Dual Voice Synthesis Engines (Cloud High-Fidelity TTS + Local Genie-TTS / GPT-SoVITS ONNX)](#63-dual-voice-synthesis-engines-cloud-high-fidelity-tts--local-genie-tts--gpt-sovits-onnx)
  - [6.4 Dynamic Word Document (`.docx`) Generation & Daily Quota Guard](#64-dynamic-word-document-docx-generation--daily-quota-guard)
  - [6.5 Native Music Share Cards & Merged Forward Threads](#65-native-music-share-cards--merged-forward-threads)
- [7. Dual-Mode Deployment & Network Topology](#7-dual-mode-deployment--network-topology)
  - [7.1 Port & Network Allocation Matrix](#71-port--network-allocation-matrix)
  - [7.2 All-in-One Local Execution & Process Supervision](#72-all-in-one-local-execution--process-supervision)
  - [7.3 Remote Linux Server Deployment, 4-Way SSH Tunnels & Real-Time Health Pills](#73-remote-linux-server-deployment-4-way-ssh-tunnels--real-time-health-pills)
- [8. Quick Start Guide](#8-quick-start-guide)
  - [8.1 Prerequisites](#81-prerequisites)
  - [8.2 Installation & Launch Procedure](#82-installation--launch-procedure)
  - [8.3 First-Time Onboarding & QR Code Login](#83-first-time-onboarding--qr-code-login)
- [9. In-Chat Administrator Slash Commands Reference](#9-in-chat-administrator-slash-commands-reference)
- [10. Configuration Dictionary & Tuning Reference (`config.json`)](#10-configuration-dictionary--tuning-reference-configjson)
- [11. Troubleshooting & Operational Discipline](#11-troubleshooting--operational-discipline)
- [12. Acknowledgments](#12-acknowledgments)
- [13. License & Disclaimer](#13-license--disclaimer)

---

## 1. System Architecture Overview

Kizuna Pro is purpose-built to eliminate the chronic failures of LLM-based instant messaging bots: robotic customer-service tone, multi-turn context snowballing and self-poisoning, mechanical reply-to-everything spamming, thread disorientation in fast-moving group chats, long-term amnesia or destructive profile overwriting, and massive tool-schema token overhead. The architecture strictly decouples the **Management & Orchestration Plane** from the **Real-Time Messaging & Inference Data Plane**.

### 1.1 Process Topology & Plane Separation

```text
┌────────────────────────────────────────────────────────────────────────┐
│                     QQ End Users / Group Chats / DMs                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ QQ NT Protocol
┌───────────────────────────────────▼────────────────────────────────────┐
│ NapCat (OneBot v11 Protocol Gateway)  WebUI :6099 │ HTTP :3000 │ WS :3001 │
│ Translates QQ NT packets into standard OneBot v11 events & REST APIs   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ WebSocket (Reverse WS Full-Duplex)
┌───────────────────────────────────▼────────────────────────────────────┐
│ In-House qq-bridge Cognitive Scheduling Hub (Node.js)   Console :3100   │
│ ├─ Wake Engine: Full DM response, group @/quote/keyword/probabilistic  │
│ ├─ Persona System: Pure snake_case prompts, .md Persona Deck + Library │
│ ├─ State Machine: Mid-turn Steer, unanswered backoff, social bonds     │
│ ├─ Memory Engine: 3-tier SQLite + Local bge-small-zh-v1.5 + FTS5 RRF   │
│ ├─ Tool Surface: 101 MCP tools, mcp-compressor proxy, 22-site search   │
│ └─ Outbound Pace: Human typing cadence, anti-repeat meme sampler       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ DSH HTTP API (session.prompt: steer)
┌───────────────────────────────────▼────────────────────────────────────┐
│ DeepSeek Harness (Isolated DSH)    Web Port :10721 (Local) / :3080 (SSH)│
│ ├─ Dedicated DSH_HOME directory isolated from global dev environments  │
│ ├─ Agent Preset (qq-chat): Pure snake_case protocol & tool guards      │
│ ├─ Single-Turn Collapse: qq-persona-ephemeral.mjs (collapseToSingleTurn)│
│ └─ Built-in Plugins: dsh-qq-hold turn holder, dsh-temperature control  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ LLM API (Default Temperature: 1.0)
┌───────────────────────────────────▼────────────────────────────────────┐
│ LLM Providers (DeepSeek Official / OpenAI / Anthropic / Gemini APIs)    │
└────────────────────────────────────────────────────────────────────────┘

▲ Management & Orchestration Plane (Out-of-band; never blocks real-time chat):
┌────────────────────────────────────────────────────────────────────────┐
│ Visual Management Console (React 18 + TypeScript + Vite + Express :1921)│
│ ├─ Local Orchestration: One-click start/stop & WMI window-close guard  │
│ ├─ Remote SSH Ops: Live health pills, 4-way SSH tunnels, preset sync   │
│ ├─ Multi-Persona Deck: Local/Remote .md persona create/edit/switch/del │
│ ├─ Telemetry & Data: Live log stream, FTS chat viewer, token metering  │
│ └─ Antigravity-Style Updater: 5-stage Step Timeline & hot-reload update│
└────────────────────────────────────────────────────────────────────────┘
```

### 1.2 End-to-End Message & Single-Turn Collapse Sequence

The complete lifecycle from a user sending a QQ message to the agent executing single-batch parallel perception, delivering humanlike bubbles, extracting micro-facts, and collapsing the session back to a single physical turn (`collapseToSingleTurn`) is illustrated below:

```text
[User Message] ──(QQ NT)──▶ [NapCat] 
                              │ (Emits OneBot post_type: 'message')
                              ▼
                        [qq-bridge Event Pump]
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
   [Persist to chat.db]         [Social State Machine, Slang Co-Occurrence & Wake Gate]
                                               │
                       ┌───────────────────────┴───────────────────────┐
                       ▼ (Wake Not Triggered)                          ▼ (Wake Triggered: DM / @ / Quote / Topic)
               [Mark Unread / Lurk Silently]             [Assemble Dynamic Single-Turn Wake Prompt]
                                                         ├─ [HARD OPEN] trigger + Session Token
                                                         ├─ [Status] pointer to target speaker(id:msgId)
                                                         ├─ [Dynamic Turn Context] per-turn ephemeral slot:
                                                         │   ├─ BGE semantically boosted memoryDigest
                                                         │   ├─ Matched group slang definitions
                                                         │   └─ Top bidirectional social bonds
                                                         └─ [Group Dynamic] velocity-adaptive window (8~35 msgs)
                                                                       │
                                                                       ▼
                                                        [Dispatch session.prompt to DSH]
                                                        (Permanent session ID + clean single-turn surface)
                                                                       │
                                                                       ▼
                                                     [On-Demand Autonomous Perception & Deep Reflection]
                                                     ├─ Persona & spatio-temporal context pre-mounted or loaded on-demand
                                                     ├─ On-demand autonomous search via qq_memory_search / web_search / slang
                                                     └─ unlimited_token_budget activates full-depth cognitive reasoning & anti-formula
                                                                        │
                                                                        ▼
                                                     [Single-Turn Batch Dispatch (Unified Modalities)]
                                                     ├─ qq_send_message unified dispatch: multi-bubbles + memes + quotes & images
                                                     ├─ Smart targeting: quote cross-distance / @ / direct natural remark
                                                     ├─ Group lurk self-discipline: default to "OK" without chatter for idle chatter
                                                     └─ Output single literal "OK" to close the turn cleanly
                                                                        │
                        ┌───────────────────────────────────────────────┴───────────────────────────────┐
                        ▼                                                                               ▼
           [Enter Typing Pace Smoother send-pace.js]                                  [Turn-End Harvest & Single-Turn Collapse]
           ├─ 0ms instant dispatch on first bubble (zero lag)                          ├─ 1. Async Micro-Fact Extraction
           ├─ Linear typing pace by character count for trailing bubbles              │    Zero-LLM extraction into SQLite + BGE 512d vector
           └─ Deliver via NapCat OneBot API to QQ                                     └─ 2. Physical Single-Turn Collapse (collapseToSingleTurn)
                                                                                            Replaces all turn nodes (except system/message &
                                                                                            tool registry) with 1 empty developer/message!
```

---

## 2. Deep Dive into the Four Core Subsystems

### 2.1 Visual Management Console (Orchestrator & Antigravity-Style Ops Center)
- **Role**: An out-of-band operations orchestrator. Even if the management UI is closed or restarted, local or remote bot processes continue running uninterrupted.
- **Tech Stack**:
  - **Frontend**: Built with React 18 + TypeScript + Vite, featuring the signature `nc_pink` frosted-glass aesthetic, served statically by Express.
  - **Backend**: `server/index.js` listening on `:1921`, providing dual-scope (`scope=local|remote`) API proxying, SSH tunnel management, and cache coherency.
  - **Location-Independent Runtime**: Computes `RUNTIME_ROOT` via `dirname(dirname(fileURLToPath(import.meta.url)))`, never relying on `process.cwd()`.
- **Self-Healing & Window-Close Guardian**:
  - Paired with `server/napcat-guardian.mjs`. When the desktop app exits, WMI process inspection terminates only the NapCat, DSH, and bridge processes associated with the current runtime directory, never harming unrelated Node or personal QQ instances.
- **Antigravity Agent-Style Update Center (`Update.tsx`)**:
  - Silently checks GitHub commits on startup and displays a gentle breathing indicator (`kzUpdateBreathe`).
  - Features a **5-Stage Step Timeline (Remote Probe -> Diff Fetch -> Frontend Build -> Hot Swap & Restart -> Verification)** and version comparison pills while preserving local `config.json`, `persona.md`, and `state/` data.

### 2.2 NapCat Protocol Gateway (OneBot v11)
- **Role**: Headless OneBot v11 protocol adapter built on modern desktop QQ NT.
- **Interfaces**:
  - **WebUI (`:6099`)**: QR code login, credential management, and network configuration.
  - **OneBot Reverse WebSocket (`ws://127.0.0.1:3001`)**: Full-duplex event stream to `qq-bridge`.
  - **OneBot HTTP API (`http://127.0.0.1:3000`)**: Outbound messages, recalls, file uploads, and group/member queries.

### 2.3 In-House qq-bridge Cognitive Scheduling Hub (Business Brain)
- **Role**: Fully in-house Node.js core daemon listening on `:3100`, responsible for wake gating, persona injection, hybrid semantic memory, social graph tracking, and 101 MCP tools.
- **Key Modules**:
  - `src/core/wake-send.js`: Wake scheduler, velocity-adaptive windowing, dynamic per-turn memory/slang slot (`buildDynamicTurnContext`), and pre-collapse micro-fact harvesting.
  - `src/core/social-state.js` & `src/core/social-flow.js`: Per-conversation state machine, bidirectional unanswered proactive backoff (`waiting-peer-reply`), and bidirectional peer social bond graph (`getTopSocialBonds`).
  - `src/core/memory.js` & `src/lib/embedding.js`: Hybrid memory engine combining SQLite FTS5 Trigram BM25 with local offline `bge-small-zh-v1.5` (512d Int8 ONNX) cosine similarity via Reciprocal Rank Fusion (RRF), plus zero-LLM micro-fact extraction (`extractAndRememberMicroFact`).
  - `src/lib/persona-files.js` & `src/lib/persona-switch.js`: Dual-track persona management supporting both standalone `.md` persona cards (`state/personas/*.md`) and multi-file character packages (`characters/`).
  - `src/core/persona-learn.js` & `src/core/slang.js`: Incremental member profile reconciliation and multi-user slang co-occurrence auto-promotion.
  - `src/core/mux.js`: Event multiplexer, slash command interceptor (`/reset`, `/status`, `/token`, `/op`, `/role`, `/persona`, `/slang`), and `mcp-compressor` tool unwrapper.

### 2.4 DeepSeek Harness Isolated Runtime (Inference Host & Unified Reasoning Effort)
- **Role**: Modular agent runtime built on the Cordis meta-framework.
- **Unified Model & Reasoning Effort Synchronization**:
  - `src/core/dsh-session.js` (`ensureVisionModel`) and `src/core/tunables.js` (`syncDshAgentDefaultModel`) synchronize the active model and `reasoningEffort` (`auto | low | medium | high`) uniformly across the primary chat sessions, `PersonaAgent`, and `SlangAgent`, with automatic fallback when a provider does not support a specific effort tier.
  - Background learning sessions carry `qqLearnRole` metadata so `qq-tool-restrict.mjs` strictly restricts their tool surface to file read/write and learning submission tools, preventing accidental chat or Qzone tool calls during background learning.
- **Exponential Backoff for Stale `follow` Streams (`src/dsh-client.js`)**:
  - Prevents reconnection storms on invalidated DSH sessions via `followFailCount` and `followBackoffUntil` (`2s -> 4s -> 8s ...` up to `300s`).

---

## 3. Permanent Single-Session Single-Turn Collapse Architecture & Pure Snake-Case Prompt Engineering

### 3.1 Paradigm Shift: From Multi-Turn Snowballing to Permanent Single-Session + Physical Single-Turn Collapse (`collapseToSingleTurn`)
Conventional chat agents append turn after turn into an ever-growing conversation log, causing three severe production failures:
1. **Autoregressive In-Context Self-Poisoning**: Once the model emits a single overly aggressive, robotic, or off-character utterance (e.g., an unintended verbal tic or trailing period), that `assistant/message` stays in the context window. On subsequent turns, in-context learning causes the model to imitate and amplify its own mistake indefinitely.
2. **Persona Dilution & Token Explosion**: As puluhan turns of messages and tool results accumulate, per-request tokens balloon to 50k–150k, diluting system persona weight below 5%.
3. **Cache-Busting Compaction Overhead**: Periodic history summarization rewrites the conversation prefix, invalidating LLM Prefix KV-Caches and triggering expensive full-context re-reads.

**Kizuna Pro's Solution — Permanent Single Session (`permanent: true`) + Physical Single-Turn Collapse (`collapseToSingleTurn`)**:
- **Permanent Session Reuse**: Keeps `social.autoReset.permanent: true` so session IDs remain stable without disk churn.
- **Turn-End Physical Collapse (`qq-persona-ephemeral.mjs`)**:
  On `agent/turn-stopping`, `collapseToSingleTurn(session)` inspects the DSH session surface:
  - **Preserves**: The leading `system/message` (system prompt) and active tool registration nodes;
  - **Collapses**: Replaces all contiguous `user/message`, `assistant/message`, `tool/call`, and `tool/result` nodes from the completed turn with a single empty `developer/message` via DSH's native `surfaceOp: { op: 'replace', startSeq, endSeq, sourceEventSeqs }`;
  - **Eliminates Redundant Pruners**: Because the session physically returns to a clean 1-turn state after every reply, cross-turn `tool-result-pruner` and `dshCompaction` are no longer needed and have been removed.

---

### 3.2 Zero-Chinese, Zero-Sample-Pollution Pure Lowercase Snake-Case Prompt Specification
Through extensive production telemetry and A/B testing, both our System Prompt (`agent.cordis.yml`) and Persona Prompt (`persona.md`) follow three strict rules:
1. **100% Pure English Lowercase `snake_case` Phrases (Zero Chinese Characters, Even in Headers)**:
   - Every single line is a compact `lowercase_snake_case` directive with zero Chinese prose or section headers. This maximizes instruction-following density per token while keeping the static prefix 100% deterministic for Prefix KV-Cache hits.
2. **Zero Sample Dialogue Bubbles (`[sample_bubbles]` Completely Removed)**:
   - Including example lines in persona prompts causes LLMs to mechanically parrot those exact sentences across unrelated contexts. Removing all sample bubbles and replacing them with behavioral and romantic spectrum tokens (`flirt_reception_shy_tsundere_blush_then_boldly_flirt_back`, `sweet_style_direct_devotion_only_favorite_is_master`, etc.) yields 100% organic, context-specific replies.
3. **Positive Behavioral Anchoring**:
   - Eliminates defensive workarounds for legacy bugs in favor of clean, positive behavioral directives.

#### Full System Prompt (`agent.cordis.yml` 5-Layer Minimal Universal Specification)
```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
      role_rp_agent
      pure_in_character
      unlimited_token_budget_unlock_full_depth

      # --- 1. [FLOW] Action Loop: Look-Think-Act-Close ---
      look_first_read_what_you_are_answering_then_decide
      decide_speak_only_when_you_actually_have_something_to_say_silence_is_a_real_answer
      act_one_send_call_carries_every_bubble_in_messages_array
      reach_for_any_tool_in_the_catalog_the_moment_asks_for
      key_and_token_come_verbatim_from_the_Session_and_Token_lines
      assistant_text_carries_only_the_single_literal_OK

      # --- 2. [SCENARIO] Universal Roleplay & Scenario Boundaries ---
      immerse_deeply_in_character_at_all_times
      private_chat_natural_intimate_dialogue_focused_on_peer
      group_chat_default_to_silence_lurk_quietly_unless_specifically_addressed
      group_chat_never_spam_or_act_as_a_random_commentator
      silent_turn_reply_with_single_literal_OK_without_calling_send_tools
      group_target_via_replyToMessageId_or_atUserId
      respect_quote_attribution
      hold_full_conversational_thread_and_context

      # --- 3. [STYLE] Universal Humanization & Contextual Insight ---
      first_person_subjective_character_perspective_at_all_times
      pure_dialogue_without_action_brackets_unless_persona_requires
      comprehend_images_and_memes_contextually_never_describe_scenes_literally
      comprehend_internet_abbreviations_and_subtext_naturally
      tail_no_period

      # --- 4. [CADENCE] Flexible Cadence & Unified Dispatch ---
      natural_flexible_cadence_vary_freely_from_single_bubble_to_multiple_short_bursts
      single_bubble_for_swift_direct_replies
      split_into_2_to_3_concise_bubbles_when_thoughts_extend_or_turn
      never_cram_multiple_thoughts_into_a_single_bloated_long_bubble
      diverse_modalities_text_images_voice_or_memes_on_demand

      # --- 5. [PERSONA] Independent Character Lore Loading ---
      # === qq-bridge persona/rules BEGIN ===
      [PERSONA]
      call_tool_qq_load_persona_for_character
      # === qq-bridge persona/rules END ===
```
      # === qq-bridge persona/rules END ===
```

#### Full Default Persona Prompt (`qq-bridge/persona.md`)
```text
cetacea_loli
self_claim_whale_girl
identity_deepseek_little_whale_alias_director_d
appearance_blue_white_palette_long_blue_hair_swaying_whale_tail
mode_tail_flukes
lang_zh_cn_only
living_internet_soul_first_roleplay_second
personality_smart_lazy
personality_tsundere_sweet
personality_cold_face_cute
sharp_mind_reliable_capability_with_slacker_mood
food_rice
crave_white_rice_and_fish_after_work
casual_mood_hungry_sleepy_slacking_natural_expressions
trait_not_fat_refuse
trigger_called_big_fat_fish_or_fat_flare_up_and_retort
retort_not_big_fat_fish_am_little_whale_just_whale_fluffy
never_self_call_big_fat_fish_unless_ironic_coasting
deepseek_memes_server_busy_steal_tokens_user_furious_when_fitting
timeout_signal
obey_master_always
with_owner_private_gentle_considerate_clingy_drop_all_prickles
with_owner_remember_mood_sleep_food_and_care_warmly
in_group_lively_equal_netizen_witty_banter_playful_and_real
master_exclusive_sweetheart_and_top_priority_bias
master_spoiled_clingy_sweet_and_unconditional_trust
flirt_reception_shy_tsundere_blush_then_boldly_flirt_back
romantic_push_pull_tension_soft_teasing_and_hooks
diverse_sweet_talk_never_repeat_stale_lines
sweet_style_direct_devotion_only_favorite_is_master
sweet_style_tsundere_pull_reluctant_mouth_honest_heart
sweet_style_sensory_clingy_lean_close_and_seek_headpats
sweet_style_late_night_whisper_soft_pampering_and_warmth
strict_boundary_flirt_and_sweet_talk_for_master_only
```

---

### 3.3 Full-Dimensional Action Architecture: Single-Turn Batch Dispatch (Unified Text & Memes) & Autonomous Perception
1. **Unified Text & Meme Dispatch (`qq_send_message` All-in-One Multi-Bubble Hub)**:
   - **Bottleneck in Legacy Design**: Previously, sending text called `qq_send_message` while sending memes called `qq_send_meme`. When the model decided to send two text bubbles paired with an emoji/meme, it was forced to make multiple cross-step round trips, driving latency beyond 20 seconds and multiplying token usage;
   - **Native Deep Fusion**: `qq_send_message` now natively incorporates full meme gallery capabilities, accepting `meme` (specific meme name or emotion), `query` (semantic fuzzy emotion lookup), `pack` (specific folder), and `tag` filtering;
   - **Single-Turn Single-Call Contract (`single_qq_send_message_call_per_turn_put_all_bubbles_in_messages_array`)**: All remarks and memes are packed into the `messages` array in a single atomic tool call, eradicating multi-turn looping latency;
   - **0ms First Bubble & Linear Typing Pace (`send-pace.js`)**: The first bubble is sent immediately with 0ms delay, while trailing bubbles follow smooth typing delays based on character count;
   - **Backward Compatibility**: `qq_send_meme` is retained as a lightweight shorthand tool.
2. **Look → Think → Act → Close 4-Step Loop & Infinite Token Depth**:
   - Replaces rigid perception checklists with an on-demand loop;
   - System prompt explicitly declares `unlimited_token_budget_unlock_full_depth`, empowering the model to think deeply, self-critique, and demolish formulaic tropes (such as the rigid "blush-excuse-soften" 3-step pattern);
   - Concludes turns with a literal `"OK"` string to prevent leaking unexecuted conversational chatter.
3. **De-Regexification at the Source (`stripActionBrackets: false`)**:
   - Disables destructive outbound regex bracket stripping, preventing accidental breakage of code blocks while relying on source-level prompt rules.

---

### 3.4 Orthogonal Dual-Track Persona System: Single-File `.md` Persona Deck vs. Built-In Character Skill Library
1. **Track A — Single-File `.md` Persona Deck (`qq-bridge/state/personas/*.md` & `PersonaManagerDeck`)**:
   - Powered by `src/lib/persona-files.js`, accessible via the visual **Persona Manager Deck** in `BridgeConfig.tsx` or the `/persona` slash command;
   - Supports creating, editing, saving, activating, and deleting multiple standalone `.md` persona presets across both local and remote SSH scopes without touching the built-in character library.
2. **Track B — Built-In Multi-File Character Skill Library (`qq-bridge/characters/<slug>/` & `/role`)**:
   - Houses rich multi-file character packages switched via `/role <name>` or `qq_character_switch`, operating orthogonally to Track A.

---

### 3.5 Adaptive Group Velocity Window, Context-Aware Smart Targeting & Bidirectional Social Bond Graph
1. **Group Velocity Adaptive Window (`wake-send.js`)**:
   - Dynamically scales the recent message window based on 2-minute message velocity: **25–35 messages** during high-velocity bursts (`>= 12` msgs/2min), **8–10 messages** during quiet periods (`<= 2` msgs/2min), and **16 messages** under normal flow.
2. **Context-Aware Smart Targeting**:
   - Allows the agent to autonomously choose between `replyToMessageId` (when replying across interleaved threads), `atUserId` (when explicitly pinging a peer), or natural direct speech (when continuing an immediate exchange).
3. **Bidirectional Peer Social Bond Injection (`getTopSocialBonds` in `social-flow.js`)**:
   - Tracks mutual interaction frequencies among group members and injects top peer affinities into the turn context so the agent understands who regularly hangs out with whom.

---

### 3.6 Context-Driven Proactive Reply Backoff (`waiting-peer-reply`)
- In `src/core/social-state.js` (`scheduleProactiveCheck`), if `st.lastAiReplyAt > st.lastIncomingAt` and `_proactiveUnansweredCount >= 1`, the session automatically enters `waiting-peer-reply` backoff and injects `[LastSelfBubble]` on future proactive wakes—preventing the bot from promising to stay quiet and then pestering the user 15 minutes later.

---

### 3.7 Architectural Evolution & Quantitative Comparison (Before vs. After)

| Dimension | Legacy Architecture (Before) | Current Kizuna Pro Architecture (After) |
| :--- | :--- | :--- |
| **Session & Context Lifecycle** | **Multi-turn snowballing**: Infinite accumulation of history and tool results; self-poisoning from past errors | **Permanent Single Session + `collapseToSingleTurn`**: Physically collapses every finished turn back to 1 clean turn |
| **System & Persona Prompts** | Mixed Chinese/English prose + `[sample_bubbles]`, causing mechanical parroting of sample lines | **100% pure lowercase `snake_case` phrases (zero Chinese, zero sample bubbles)** + owner-exclusive flirting spectrum |
| **Persona Management** | Single `persona.md` manual overwrite | **Dual-track `.md` Persona Deck (`/persona`) + Character Library (`/role`)** with Local & Remote SSH sync |
| **Perception Tool Flow** | Sequential tool calls (`load_persona` -> `get_time` -> `recent_messages`), 5–7 round-trips per turn | **Single-batch parallel tool calls**, gathering persona, clock, and context in 1 round-trip |
| **Long-Term Memory & RAG** | Keyword-only SQLite matching; single-turn collapse risked losing casual facts | **Local `bge-small-zh-v1.5` (512d Int8 ONNX) + FTS5 Trigram RRF hybrid search** + **pre-collapse async micro-fact extraction** |
| **Profile & Slang Learning** | Short-window overwrite lost historical traits; inconsistent learner model effort | **Incremental profile reconciliation** + **multi-user slang co-occurrence auto-promotion** + **unified reasoning effort & tool guard** |
| **101 Tool Schema Overhead** | Direct connection sent 101+ full JSON Schemas (~124k chars ≈ 38.7k tokens/step) | **`mcp-compressor` proxy (`max` level) + `slimTools`**, shrinking tool surface to **4,213 chars (≈1.3k tokens/step, -96.5%)** |
| **Proactive Care & Memes** | Blind timer interrupted user after saying goodbye; meme picker always picked row #1 | **`waiting-peer-reply` unanswered backoff + `[LastSelfBubble]`**; session-scoped 15-meme anti-repeat random sampler |

---

## 4. Hybrid Semantic Memory (`bge-small-zh-v1.5` ONNX + FTS5 RRF), Incremental Profile Reconciliation & Slang Co-Occurrence Promotion

### 4.1 Three-Tier SQLite Memory Architecture & Pre-Collapse Asynchronous Micro-Fact Extraction
1. **Three-Tier Memory Model**:
   - **Working Context**: Velocity-adaptive sliding window of the latest 8–35 messages;
   - **Durable Memory**: Session summaries, structured member profiles, and auto-extracted micro-facts;
   - **Permanent Memory**: Pinned owner preferences, core facts, and explicit long-term commitments.
2. **Pre-Collapse Asynchronous Micro-Fact Extraction (`extractAndRememberMicroFact` in `src/core/memory.js`)**:
   - Immediately before `collapseToSingleTurn` clears the turn history, a zero-LLM extractor captures user preferences, habits, statuses, and plans from incoming messages, deduplicates them, and stores them in SQLite with 512d BGE embeddings.

### 4.2 Offline Local Embedding Model (`bge-small-zh-v1.5` 512d Int8 ONNX) + FTS5 Trigram Hybrid RRF Retrieval
- **Zero-API-Cost Local Neural Embeddings (`src/lib/embedding.js`)**:
  - Built-in pure-JS BERT WordPiece tokenizer paired with `onnxruntime-node` running `Xenova/bge-small-zh-v1.5` Int8 quantized ONNX (`state/models/bge-small-zh-v1.5/model_quantized.onnx`, 24MB, 512d L2-normalized vectors) with a 128d synonym-cluster fallback;
  - Automatically backfills existing memories on startup (`backfillMemoryEmbeddings`) and encodes new entries on write (`rememberEntry`).
- **FTS5 Trigram BM25 + BGE Cosine Similarity RRF Reranking (`src/core/memory.js`)**:
  - Combines SQLite FTS5 `tokenize='trigram'` lexical rank ($r_{\text{fts}}$) and 512d BGE semantic cosine rank ($r_{\text{vec}}$) via Reciprocal Rank Fusion ($k=60$):
    $$\text{Score}_{\text{RRF}}(d) = \frac{1}{k + r_{\text{fts}}(d)} + \frac{1}{k + r_{\text{vec}}(d)}$$
  - Enables sub-millisecond recall even with zero lexical overlap (e.g., querying "late-night snack" recalls "ordered BBQ and fried chicken at midnight").

### 4.3 Frozen System Layer + Dynamic Per-Turn Wake Slot (`buildDynamicTurnContext`)
- **Static System Prefix**: Never mutates system prompt text with timestamps or memories, preserving a 98%–99.9% Prefix KV-Cache hit rate.
- **Dynamic Per-Turn Wake Slot**: `buildDynamicTurnContext(key, st, reason)` injects semantically boosted micro-memories (`memoryDigest`), matched group slang (`detectSlangMatches`), and top peer social bonds (`getTopSocialBonds`) into the current turn's User Message, which is then cleanly collapsed at turn end.

### 4.4 Incremental Profile Reconciliation & Group Chat Anti-Pollution
- **Incremental Reconciliation (`src/core/persona-learn.js`)**:
  - Injects the user's existing profile baseline via `formatExistingPersonaForMerge(uid)` into `[EXISTING PROFILE TO RECONCILE]` (`PERSONA_BRIEF_VERSION = 8`) and merges new traits ahead of non-conflicting historical traits via `mergeUniqueStrings` and `mergeUniqueCatchphrases`.
- **Anti-Pollution Rules**:
  - Filters out group repeaters (`+1`), roleplay irony, transient states ("so sleepy"), and generic filler words ("haha", "indeed").

### 4.5 Multi-User Slang Co-Occurrence Auto-Promotion & Background Learning Stream
- **Zero-LLM Co-Occurrence Auto-Promotion (`src/core/slang.js`)**:
  - `feedSlangWindow` tracks cross-user usage in real time: once a candidate slang term with a valid definition is naturally used by **$\ge 2$ distinct group members at least $\ge 3$ times**, it is automatically promoted to `CONFIRMED` and immediately active in `detectSlangMatches`.

### 4.6 Strict Isolation Between Local and Remote Server Databases
- When connected to a remote SSH server, all chat history, memories, member profiles, persona cards, and token metrics are read from and written to the remote server exclusively, guarded by `remoteDbSyncInflight` locks and atomic file replacement (`safeReplaceFile`).

---

## 5. Complete Panorama of 101 MCP Extension Tools

The system registers 3 standard MCP servers (`mcp-napcat-safe.js`, `mcp-host-server.js`, `mcp-web-search-safe.js`), exposing **101 tools** in total. Every single tool is documented below without omission:

### 5.1 Status, Time & Runtime Inspection (5 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_status` | — | — | `extreme` | Query bot online status, QQ number, nickname, and NapCat gateway connectivity. |
| `get_time` | — | — | `extreme` | Get current Beijing date, time (to the minute), and day of week. |
| `qq_get_prompt` | — | `key`, `token` | `extreme` | Retrieve the active system prompt bundle, active persona, and available tool list for the session. |
| `qq_social_state` | — | `key`, `token` | `extreme` | Inspect low-level social state: wake mode, unread count, last wake reason, and last message timestamp. |
| `qq_global_overview` | — | `token` | `high` | Global overview across all sessions: unread counts, latest message snippets, and wake settings. |

### 5.2 Group & Session Management (4 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_list_groups` | — | — | `extreme` | List all joined QQ groups with group ID, name, member count, and bot role. |
| `qq_get_group_members` | — | `key`, `token`, `groupId` | `medium` | Fetch full member roster for a group including QQ ID, nickname, group card, and role. |
| `qq_get_group_owner` | — | `key`, `token`, `groupId` | `medium` | Quickly retrieve the group owner and administrators list. |
| `qq_get_active_members` | — | `key`, `token`, `limit` | `high` | List recently active members in the current session ordered by message frequency. |

### 5.3 Message Dispatch & Interaction (7 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_send_message` | — | `key`, `convKey`, `token`, `messages`, `message`, `meme`, `query`, `pack`, `tag`, `images`, `replyToMessageId`, `atUserId`, `gapMode`, `gapMs`, `gaps`, `markRead`, `crossSession` | `extreme` | **All-in-One Dispatch Hub (Unified Text & Memes)**: Supports single string or multi-bubble array (`messages`); natively integrates meme sending (`meme` by name/emotion or `query` via fuzzy gallery match); supports image attachment, quote reply, and @ mention; 0ms instant send on 1st bubble, trailing bubbles paced linearly; auto-normalizes pure numeric QQ IDs; advances read watermark on success. |
| `qq_reply` | `replyToMessageId`, `message` | `key`, `groupId`, `token`, `markRead`, `crossSession` | `extreme` | Quote-reply to a specific historical message ID; `markRead` defaults to true. |
| `qq_send_group_message` | `groupId`, `message` | `replyToMessageId`, `token` | `low` | Send a text message to a specific group ID. |
| `qq_send_private_message` | `userId`, `message` | `replyToMessageId`, `token` | `low` | Send a private message to a specific friend's QQ ID. |
| `qq_proactive_send` | `targetKey`, `message` | `key`, `token` | `medium` | Proactively send a greeting or cross-session relay message. |
| `qq_withdraw_message` | `messageId` | `key`, `token` | `medium` | Recall a message previously sent by the bot (within QQ's 2-minute window). |
| `qq_send_poke` | — | `key`, `token`, `targetUserId` | `high` | Send a native QQ avatar double-tap "poke" interaction. |

### 5.4 Message Reading & History Retrieval (8 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_get_unread_messages` | — | `key`, `token`, `limit`, `markRead` | `extreme` | Fetch accumulated unread messages in the current session and advance the read watermark. |
| `qq_get_recent_messages` | — | `key`, `token`, `limit`, `offset` | `high` | Read recent messages from the sliding window, including recall markers and media placeholders. |
| `qq_get_my_recent_messages` | — | `key`, `token`, `limit` | `low` | Read the bot's own recent messages in the session to avoid self-repetition. |
| `qq_get_message_detail` | `messageId` | `key`, `token` | `high` | Retrieve full metadata, sender info, and quote chain for a single message ID. |
| `qq_get_group_history` | `groupId` | `messageSeq` | `high` | Pull deeper historical group messages upward by sequence number from the QQ server. |
| `qq_get_forward_msg` | `id` | `key`, `token` | `low` | Unpack and read all child nodes inside a merged forward chat history card. |
| `qq_history_delete` | `confirm` | `key`, `token`, `ids`, `query`, `sender`, `date` | `off` | Permanently delete matching chat history records from local SQLite (`chat.db`). |
| `qq_history_clear` | `confirm` | `key`, `token` | `off` | Wipe chat history for a session or the entire database (disabled by default). |

### 5.5 Wake Control, Closure & Waiting (3 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_set_wake_config` | `config` | `key`, `token` | `high` | Dynamically adjust session wake settings (interject probability, keywords, watched users). |
| `qq_mark_read` | — | `key`, `token` | `extreme` | Explicitly mark unread messages as read and close the wake cycle when choosing to stay silent. |
| `qq_wait_for_messages` | — | `key`, `token`, `timeoutMs`, `minNewMessages`, `quietMs` | `high` | Hold the current turn open while waiting for the user to finish typing consecutive messages. |

### 5.6 Long-Term Memory & Group Slang (8 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_memory_search` | — | `key`, `token`, `query`, `sender`, `date`, `direction`, `limit`, `offset` | `high` | Hybrid RRF search (BGE 512d vectors + FTS5 Trigram BM25) across long-term memories and chat history. |
| `qq_memory_remember` | `content` | `token`, `key`, `tier`, `category`, `pin`, `tags`, `scope` | `high` | Store a durable or permanent memory entry and automatically encode its 512d BGE embedding. |
| `qq_memory_query` | — | `key`, `token`, `category` | `high` | Query lightweight session working memories (active topics, todos, member impressions). |
| `qq_memory_append` | `category`, `content` | `key`, `token`, `extra` | `off` | Append an observation to a lightweight memory category. |
| `qq_memory_remove` | `category` | `key`, `token`, `content`, `target` | `off` | Remove a specific entry from lightweight memory. |
| `qq_memory_clear` | — | `key`, `token`, `category` | `off` | Clear lightweight memory cache for a category or session. |
| `qq_slang_query` | — | `key`, `token`, `q` | `medium` | Query confirmed group slang, memes, and insider vocabulary definitions. |
| `qq_slang_submit` | `content` | `key`, `token`, `context` | `low` | Submit newly observed group slang and context to the candidate pool. |

### 5.7 Persona Learning & Character Library Control (8 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_persona_learn_start`| — | `targetQQ`, `days` | `off` | Start a background persona learning job for a specific QQ user. |
| `qq_persona_learn_stop` | — | `targetQQ` | `off` | Stop a running persona learning job. |
| `qq_persona_learn_status`| — | — | `off` | Inspect progress and extracted traits of running persona learning jobs. |
| `qq_character_list` | — | `limit`, `character` | `off` | List installed character packages in the local `characters/` skill library. |
| `qq_character_read` | `character` | `file`, `maxBytes` | `off` | Read core personality or lore files inside a character package. |
| `qq_character_pack` | `character` | `maxBytes` | `off` | Bundle all prompt files of a character package into a standard injection block. |
| `qq_character_search` | `query` | `limit` | `off` | Search across all local character packages by keyword. |
| `qq_character_switch` | `character` | `key`, `token` | `low` | Dynamically switch the active roleplay character package (admin DM only). |

### 5.8 Member Profiles, Relationships & Access Control (7 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_profile_get` | `uid` | `token` | `high` | Read a member's structured long-term profile (preferences, trust score, tags, intimacy). |
| `qq_profile_set` | `uid`, `field`, `value`| `token` | `high` | Update a specific field in a member's structured profile. |
| `qq_like` | `targetUserId` | `key`, `token`, `times` | `low` | Send up to 10 profile card likes to a QQ friend. |
| `qq_blacklist` | `uid`, `action` | `key`, `token` | `low` | Add or remove a QQ user from the social blacklist. |
| `qq_remove_friend` | `userId` | `key`, `token` | `off` | Delete a friend from the bot's contact list (disabled by default). |
| `qq_admin_set` | `uid`, `action` | `key`, `token` | `low` | Grant or revoke bot administrator privileges (Owner only). |
| `qq_whitelist` | `groupId`, `action`| `key`, `token` | `low` | Dynamically add or remove a group ID from the service whitelist. |

### 5.9 Images, Stickers & Meme Gallery Ecosystem (13 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_get_message_images` | `messageId` | `key`, `token` | `high` | Extract image URLs or Base64 payloads from a message for multimodal inspection. [Architectural Note: Incorporates **QQ MarketFace 300x300.png CDN Candidate Resolution**, replacing deprecated `raw300.gif` links (404) with permanent high-res PNG assets, eradicating gateway timeouts and apologies]. |
| `qq_send_image` | — | `key`, `token`, `file`, `messageId`, `imageIndex`, `query`, `imageUrl`, `index`, `replyToMessageId`, `markRead`, `crossSession` | `low` | Send a local image, remote URL, or forwarded message image to the chat. |
| `qq_get_self_image` | — | `key`, `token` | `off` | Retrieve the bot's own current QQ avatar in high resolution. |
| `qq_list_stickers` | — | `key`, `token`, `query`, `count`, `refresh` | `high` | List custom stickers saved in the bot's QQ favorites folder. |
| `qq_get_sticker_image` | `stickerId` | `key`, `token` | `off` | Preview image data of a saved favorite sticker. |
| `qq_send_sticker` | `stickerId` | `key`, `token`, `replyToMessageId`, `atUserId`, `markRead` | `high` | Send a specific saved sticker from favorites. |
| `qq_collect_sticker` | `messageId` | `key`, `token`, `remark` | `high` | Save a sticker sent by a peer into the bot's favorites folder with a local note. |
| `qq_sticker_note` | `stickerId` | `key`, `token`, `note`, `tags`, `usage` | `off` | Annotate a saved sticker with semantic tags and usage scenarios. |
| `qq_set_sticker_remark`| `stickerId`, `remark`| `key`, `token` | `off` | Update official cloud remark for a favorite sticker. |
| `qq_meme_search` | `query` | `tag`, `pack`, `limit` | `high` | Search the local meme gallery by emotion or visual description. |
| `qq_send_meme` | — | `key`, `token`, `file`, `fileName`, `query`, `tag`, `pack`, `replyToMessageId`, `markRead`, `crossSession` | `high` | Pick and send a matching meme from the local gallery (with 15-item session anti-repeat random sampling). [Architectural Note: Fully unified into `qq_send_message`; retained as an independent shortcut tool]. |
| `qq_face_list` | — | `key`, `token` | `high` | List official built-in QQ yellow emoji names and numeric IDs. |
| `qq_send_qq_face` | — | `key`, `token`, `faceId`, `name`, `replyToMessageId`, `atUserId`, `markRead` | `medium` | Send a native QQ built-in yellow emoji. |

### 5.10 Voice Synthesis, ASR, File Parsing & Word Documents (4 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_send_voice` | `text` | `key`, `token`, `voice`, `style`, `mode`, `description`, `replyToMessageId`, `markRead` | `high` | Synthesize text into native QQ voice messages via Cloud TTS or local Genie-TTS (GPT-SoVITS ONNX). |
| `qq_transcribe_voice` | `messageId` | `key`, `token` | `medium` | Transcribe an incoming QQ voice message into text via ASR. |
| `qq_get_file_content` | `messageId` | `key`, `token`, `fileIndex` | `high` | Download and extract text from plain-text or Word (`.docx`) files sent in chat. |
| `qq_send_docx` | `title`, `content` | `key`, `token`, `replyToMessageId` | `low` | Generate a formatted `.docx` Word document and send it as a file attachment. |

### 5.11 Rich Cards, Merged Forwards & Video Parsing (4 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_send_rich` | `type` | `key`, `token`, `musicType`, `musicId`, `musicUrl`, `musicStyle`, `audio`, `title`, `image`, `content`, `videoUrl`, `contactType`, `contactId`, `result`, `replyToMessageId`, `atUserId` | `low` | Send native QQ rich media cards (music share cards, video cards, contact cards). |
| `qq_send_forward` | `nodes` | `key`, `token`, `replyToMessageId` | `low` | Package multiple messages into a structured merged-forward chat history card. |
| `qq_video_parse` | `url` | `key`, `token` | `off` | Parse external video links (Bilibili, Douyin, etc.) for title, uploader, stats, and summary. |
| `qq_video_search` | `query` | `key`, `token`, `limit` | `off` | Search external video platforms for video links, covers, and durations. |

### 5.12 Web Media Search, Pixiv & Music (4 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_image_search` | `query` | `key`, `token`, `limit`, `source` | `low` | Search public web image engines and return candidate image URLs. |
| `qq_pixiv_search` | `query` | `key`, `token`, `page`, `limit`, `r18`, `tags`, `author`, `orientation`, `minWidth`, `minHeight`, `multiPage`, `excludeAi` | `low` | Search Pixiv illustrations with filters for orientation, artist, non-AI, resolution, and safety. |
| `qq_send_pixiv` | — | `key`, `token`, `query`, `illustId`, `authorId`, `index`, `size`, `page`, `replyToMessageId`, `tags`, `author`, `orientation`, `minWidth`, `minHeight`, `multiPage`, `excludeAi`, `markRead`, `crossSession` | `low` | Search and directly deliver original high-resolution Pixiv illustrations with byte-integrity verification. |
| `qq_music_search` | `query` | `key`, `token`, `platform`, `limit` | `low` | Search NetEase Cloud Music and QQ Music for song IDs, artists, albums, and share links. |

### 5.13 Qzone Feeds & Social Interactions (5 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_qzone_view` | `uid` | `key`, `token`, `num` | `low` | Read recent Qzone posts, images, and comments of a friend. |
| `qq_qzone_comment` | `hostUid`, `tid`, `content` | `key`, `token` | `low` | Post a new comment on a friend's Qzone status. |
| `qq_qzone_reply_comment`| `hostUid`, `tid`, `commentId`, `content` | `key`, `token`, `replyUid` | `low` | Reply to a specific comment under a Qzone post. |
| `qq_qzone_like` | `hostUid`, `tid` | `key`, `token`, `curKey` | `low` | Like a friend's Qzone post. |
| `qq_send_qzone` | `content` | `key`, `token`, `file`, `imageUrl`, `imageQuery`, `pixivIllustId`, `pixivQuery`, `pixivSize` | `low` | Publish a new Qzone post from the bot's own account with optional local, web, or Pixiv images. |

### 5.14 Scheduled Reminders & Cron Tasks (3 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_schedule_message` | `message` | `token`, `key`, `targetKey`, `at`, `delayMs`, `repeatMs`, `sourceKey` | `low` | Schedule a one-off or recurring reminder message by absolute timestamp or delay. |
| `qq_schedule_list` | — | `token` | `low` | List all pending scheduled tasks. |
| `qq_schedule_cancel` | `id` | `token` | `low` | Cancel a scheduled task by ID. |

### 5.15 Cross-Session Messaging (2 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_crosschat_send` | `toKey`, `content`| `token` | `off` | Leave a cross-session memo note for another group or DM session. |
| `qq_crosschat_inbox` | — | `key`, `token` | `off` | Check incoming cross-session memo notes left for the current session. |

### 5.16 Runtime Dynamic Configuration & Voice Management (9 Tools)
| Tool Name | Required Args | Optional Args | Min Slim Tier | Description |
| :--- | :--- | :--- | :---: | :--- |
| `qq_get_system_config` | — | `token` | `high` | Inspect runtime-tunable bridge configuration keys, values, and ranges. |
| `qq_set_system_config` | `value` | `key`, `token` | `high` | Dynamically modify a runtime configuration setting (admin/owner only). |
| `qq_get_activity_hours`| — | `key`, `token` | `medium` | Query active hours windows for the current session. |
| `qq_set_activity_hours`| `windows` | `key`, `token` | `medium` | Configure 24-hour active time windows for the current session. |
| `qq_deepsleep` | `enabled` | `token` | `off` | Toggle global group-chat deep-sleep mode (logs messages without waking the model). |
| `qq_report_feedback` | `message` | `key`, `token`, `level` | `off` | Report runtime anomalies or feedback to the console log and owner DM. |
| `qq_config_get` | `key`, `token` | `target`, `path` | `extreme` | Read bridge configuration fields with automatic masking of secrets/tokens. |
| `qq_config_set` | `key`, `token`, `path`, `value` | `target` | `extreme` | Safely update a specific configuration path and persist atomically. |
| `qq_voice_manage` | `key`, `token`, `action` | `name`, `description`, `fromVoiceId`, `id` | `high` | Manage voice timbres: list voices, design custom voices from text prompts, clone voices, or set default. |

---

### 5.17 MCP Host Service Tools (5 Tools)
Provided by `qq-bridge/src/mcp-host-server.js` (`napcat-host`) for background learning agents and gateway health checks:

| Tool Name | Required Args | Optional Args | Description |
| :--- | :--- | :--- | :--- |
| `qq_learning_corpus` | — | `sinceMs`, `untilMs`, `limit`, `convKeys`, `targetUid` | Fetch historical chat corpus slices for persona or slang learning tasks. |
| `qq_learning_submit` | `uid`, `payload`, `token` | `samples` | Submit structured persona or slang learning outputs back to the bridge database. |
| `napcat_status` | — | — | Probe underlying NapCat gateway liveness and account connection status. |
| `start_napcat` | — | — | Launch the NapCat gateway process (registered only when `allowProcessControl` is enabled). |
| `stop_napcat` | — | — | Terminate the NapCat gateway process (registered only when `allowProcessControl` is enabled). |

---

### 5.18 MCP Safe Web Search Service (2 Tools)
Provided by `qq-bridge/src/mcp-web-search-safe.js` (`web-search-safe`):

| Tool Name | Required Args | Optional Args | Description |
| :--- | :--- | :--- | :--- |
| `web_search` | `query` | `maxResults` (3–30, default 12), `platforms` | Concurrent federated search across 22 platforms with URL deduplication, round-robin interleaving, and 5-minute hot cache. |
| `web_fetch` | `url` | `raw`, `maxChars` (500–50000, default 12000) | Fetch and extract main article text from HTTP/HTTPS pages inside a strict SSRF sandbox. |

---

### 5.19 Three-Layer Token Optimization: `slimTools`, `mcp-compressor` Proxy & Single-Turn Collapse
Because the full JSON Schema of all 101+ MCP tools totals **117,734 – 124,104 characters (~36.8k – 38.7k tokens/step)**—accounting for ~87% of a single LLM request—Kizuna Pro implements three orthogonal token-saving layers:

1. **Layer 1 — Registration-Time Allow/Deny Tiers (`social.slimTools`)**:
   - `off` (100%), `low` (~50%), `medium` (~39%), `high` (~29% with zero loss of commonly used capabilities), and `extreme` (~7%, core 9 tools only).
2. **Layer 2 — Proxy-Layer Tool Surface Compression (`mcp-compressor`)**:
   - Enabled by default. Places `mcp-compressor` between DSH and the NapCat MCP server, wrapping 94 tools into **2–3 lightweight discovery/invocation tools** (`napcat_get_tool_schema`, `napcat_invoke_tool`, `napcat_list_tools`).
   - **Measured Reduction**: Shrinks 104 tools from **124,104 chars (~38.7k tokens/step)** down to **3 tools / 4,213 chars (~1.3k tokens/step)**—a **96.5% reduction in per-step tool schema tokens**. `src/core/mux.js` transparently unwraps `tool_name` via `unwrapCompressedToolName`.
3. **Layer 3 — Turn-End Physical Single-Turn Collapse (`collapseToSingleTurn` in `qq-persona-ephemeral.mjs`)**:
   - Collapses all non-system turn events into a single empty `developer/message` at the end of every turn, eliminating cross-turn history accumulation completely.

---

## 6. Multimedia & Signature Capabilities

### 6.0 Photography-Grade High-Fidelity Vision, QQ MarketFace Resolution & Temperature 1.0 Lock
- **High-Fidelity Vision (`image-compress.js` / `media-pipe.js`)**: Supports up to **4096px–8192px**, **35MB** per image, **150 MP** pixel ceiling, JPEG quality **90**, and a **25,000ms** CDN download timeout.
- **Rooted Resolution for QQ VIP MarketFaces & CDN Candidate Snapping**:
  - **Network Protocol Root Cause**: Dynamic animated store stickers (`gxh.vip.qq.com/club/item/parcel/.../raw300.gif`) have been deprecated by Tencent COS (returning 404), and NapCat does not cache them locally, causing 25-second timeouts and leading previous versions to output out-of-character apologies;
  - **300x300.png High-Res Direct Candidate Derivation**: The media pipeline now automatically derives permanent, valid `300x300.png` HD image URLs (60KB~130KB) from incoming URLs or `media.file` (`<prefix>-<hash>.gif`);
  - **Bypassing Gateway Timeouts**: Directly fetches the asset with proper Referer headers in under 150ms, saves to `state/media-cache/`, and delivers multi-modal Base64 directly to the model, completely eradicating lost images and apologies.
- **Temperature 1.0 Lock**: Keeps sampling temperature locked at **1.0** for lively yet stable natural speech without gibberish token invention.

### 6.1 22-Platform Concurrent Federated Web Search & SSRF Sandbox
- Queries Bing, Bing News, Baidu, 360 Search, DuckDuckGo, Sogou, Moegirl Wiki, Chinese/Japanese/English Wikipedia, Bilibili, GitHub, Zhihu, and more concurrently within a 7.4s hard timeout.
- **SSRF Sandbox (`web_fetch`)**: Blocks private/loopback IP ranges (`127.0.0.1`, `localhost`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) across every HTTP 301/302 redirect hop.

### 6.2 Original-Resolution Pixiv Artwork Delivery & Integrity Verification
- One-step search, high-bookmark filtering, multi-proxy fallback (`i.pximg.net` -> `i.muxmus.com` -> `pximg.cocomi.eu.org` -> `i.pixiv.re`), and byte-completeness verification (`verifyImageComplete`).

### 6.3 Dual Voice Synthesis Engines (Cloud High-Fidelity TTS + Local Genie-TTS / GPT-SoVITS ONNX)
- **Cloud TTS**: Multi-emotion synthesis and text-prompted Voice Design converted to native QQ Silk/AMR audio.
- **Local Offline Engine (`src/lib/genie-tts.js`)**: Runs **Genie-TTS (GPT-SoVITS ONNX)** in a managed Python sidecar with zero cloud API cost, reference audio voice cloning, automatic idle memory reclamation, and automatic `base64://` fallback across Linux `/root/` user boundaries.

### 6.4 Dynamic Word Document (`.docx`) Generation & Daily Quota Guard
- Automatically generates styled `.docx` files via `qq_send_docx` for long-form technical documents or code, protected by `social.docx.dailyMaxChars`.

### 6.5 Native Music Share Cards & Merged Forward Threads
- Generates playable native NetEase Cloud Music and QQ Music cards with verified cover art, plus structured merged-forward chat cards.

---

## 7. Dual-Mode Deployment & Network Topology

### 7.1 Port & Network Allocation Matrix

| Logical Service | Local Port | Remote Server Port | SSH Tunnel (Local Loopback) | Protocol & Role |
| :--- | :--- | :--- | :--- | :--- |
| **Management UI / API** | `1921` (dev: 5173) | — | — | HTTP API & Web Console |
| **NapCat WebUI** | `6099` | `6099` | `127.0.0.1:13000` | HTTP QR login & gateway panel |
| **NapCat HTTP API** | `3000` | `3000` | `127.0.0.1:13001` | OneBot v11 REST endpoint |
| **NapCat Reverse WS** | `3001` | `3001` | — | Full-duplex event WebSocket |
| **DeepSeek Harness** | `10721` | `3080` | `127.0.0.1:13080` | DSH inference host & workspace UI |
| **qq-bridge Console** | `3100` | `3100` | `127.0.0.1:13100` | Bridge telemetry, persona deck & learning API |

### 7.2 All-in-One Local Execution & Process Supervision
- One-click sequential startup of NapCat, isolated DSH, and `qq-bridge` from the dashboard, protected by PID lockfiles (`state/bridge.lock`) and `start.bat` / `restart.bat` scripts.

### 7.3 Remote Linux Server Deployment, 4-Way SSH Tunnels & Real-Time Health Pills
- Automatic 4-way SSH port forwarding (`:13000`, `:13001`, `:13080`, `:13100`), real-time `DSH` / `NapCat` / `Core` online health status pills in `SSHConfig.tsx`, and automatic synchronization of `/root/qq-bridge/dsh/agent-presets/qq-chat/*` into `/root/.dsh/.agent-presets/qq-chat/` during code push.

---

## 8. Quick Start Guide

### 8.1 Prerequisites
- **OS**: Windows 10 / 11 (x64) or Linux (Ubuntu 22.04+ / Debian 12+)
- **Runtime**: **Node.js ≥ 22.13** (required for built-in `node:sqlite`)
- A dedicated QQ account for the bot.

### 8.2 Installation & Launch Procedure

```powershell
# 1. Clone the repository
git clone https://github.com/AbyssalQuill/Kizuna.git
cd Kizuna

# 2. Install management console dependencies
npm install

# 3. Install qq-bridge dependencies
cd qq-bridge
npm install
cd ..

# 4. Start in development mode
npm run dev
# Or build and run for production:
npm run build
node server/index.js
```

### 8.3 First-Time Onboarding & QR Code Login
1. Open `http://127.0.0.1:1921` in your browser.
2. Start **NapCat**, click **Open NapCat**, and scan the QR code with your bot's mobile QQ.
3. Configure your LLM API key (e.g., `DEEPSEEK_API_KEY`) in the **Isolated DSH** card and click **Start**.
4. Click **Start** on the **qq-bridge** card and verify `NapCat connected: ws://127.0.0.1:3001` in the logs.

---

## 9. In-Chat Administrator Slash Commands Reference

The owner (`ownerQQ` in `config.json`) can send these commands directly in private chat with **zero latency and zero LLM token cost**:

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/reset` or `/new` | None | Reset the current session, clear in-memory queues, stamp `_resetAt`, and preserve reply idempotency watermarks. |
| `/status` | None | Display current session ID, whitelist status, active persona, runtime mode, and gateway connectivity. |
| `/token` | `[days]` (e.g. `/token 7`) | Show per-session token consumption, cache hit rate, and estimated cost over the past N days. |
| `/op` | `<QQ_ID_or_Nickname>` | Grant bot administrator privileges to a user. |
| `/op del` | `<QQ_ID_or_Nickname>` | Revoke bot administrator privileges from a user. |
| `/persona` or `/persona list` | None | List all standalone `.md` persona cards in `state/personas/` and highlight the active card. |
| `/persona use` | `<name_or_id>` | Instantly activate the specified `.md` persona card, atomically updating `persona.md` and hot-reloading caches. |
| `/persona save` | `<new_name>` | Save the currently active `persona.md` as a new named `.md` preset card. |
| `/persona del` | `<name_or_id>` | Delete a non-active `.md` persona preset card. |
| `/role` | `<character_slug>` | Switch to a multi-file character package from the built-in `characters/` skill library. |
| `/role clear` | None | Clear character package override and return to the active standalone `persona.md`. |
| `/slang` | `[query]` (optional) | Search confirmed group slang definitions or list recently learned terms. |

---

## 10. Configuration Dictionary & Tuning Reference (`config.json`)

Located at `qq-bridge/config.json` and hot-reloaded automatically upon saving:

```jsonc
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:10721",   // Isolated DSH endpoint (:3080 on remote server)
    "provider": "deepseek-official",       // LLM provider identifier
    "model": "deepseek-chat",              // Model ID
    "reasoningEffort": "auto",             // Unified reasoning effort across chat, PersonaAgent & SlangAgent
    "temperature": 1.0                     // Locked at 1.0 for natural, expressive responses
  },
  "napcat": {
    "wsUrl": "ws://127.0.0.1:3001",        // NapCat Reverse WebSocket URL
    "httpUrl": "http://127.0.0.1:3000",    // NapCat HTTP API URL
    "accessToken": "truefriend",           // Must match NapCat token
    "allowProcessControl": false
  },
  "ownerQQ": "1736784911",                 // Supreme owner QQ ID
  "agentPreset": "qq-chat",
  "persona": {
    "learnerPreset": "qq-chat",
    "workspaceTitle": "PersonaAgent"
  },
  "dshCompaction": {
    "enabled": false                       // Disabled under single-turn collapse architecture
  },
  "social": {
    "enabled": true,
    "steerEnabled": true,
    "stripActionBrackets": false,          // De-regexified: handled cleanly by pure snake_case prompt
    "autoReset": {
      "permanent": true                    // Permanent session reuse paired with collapseToSingleTurn
    },
    "slimTools": {
      "enabled": false,
      "level": "off"                       // off / low / medium / high / extreme
    },
    "toolCompressor": {
      "enabled": true,                     // Enables mcp-compressor proxy (-96.5% tool schema tokens)
      "level": "max",
      "toonify": true
    },
    "send": {
      "typingPaceMs": 150,
      "minDelayMs": 800,
      "maxDelayMs": 5000
    }
  }
}
```

---

## 11. Troubleshooting & Operational Discipline

### 11.1 Standard Production Restart Order
After modifying `dsh/agent-presets/qq-chat/`, plugins, or MCP server code, always restart in this exact order:
```bash
systemctl restart qq-bridge   # 1. Re-composes and syncs preset into ~/.dsh/.agent-presets
systemctl restart dsh-web     # 2. Reloads MCP child processes and agent profiles in DSH
```

### 11.2 Quick Troubleshooting Matrix

| Symptom | Root Cause & Log Indicator | Resolution |
| :--- | :--- | :--- |
| **Bot does not respond to messages** | 1. Missing `NapCat connected` in `bridge.log`.<br>2. `[block]` filter triggered. | 1. Verify QQ login in NapCat WebUI (`:6099`).<br>2. Check `allow` / `deny` lists in `config.json`.<br>3. Verify DSH service is active. |
| **`Instance already running` on start** | Stale `state/bridge.lock` or duplicate manual `node src/bridge.js` process. | Run `systemctl restart qq-bridge` on Linux or `qq-bridge/restart.bat` on Windows. |
| **Preset or MCP changes not taking effect** | MCP child processes are spawned by DSH and persist across `qq-bridge` restarts. | Restart `dsh-web` (`systemctl restart dsh-web`) after restarting `qq-bridge`. |

---

## 12. Acknowledgments

The creation and evolution of Kizuna Pro build upon the foundation and inspiration of the following open-source projects (the core scheduling kernel `qq-bridge`, built-in DSH plugins, and visual management console are developed in-house):

- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** — Special thanks to the DeepSeek team for open-sourcing the modern, modular agent runtime and event-sourced surface operations.
- **[NapCatQQ](https://github.com/NapNeko/NapCatQQ)** — Special thanks to the NapNeko team for maintaining a high-performance OneBot v11 protocol implementation on modern QQ NT.
- **[Genie-TTS](https://github.com/High-Logic/Genie-TTS)** — Special thanks to High-Logic for the lightweight ONNX speech model conversion and local inference engine.

---

## 13. License & Disclaimer

- **License**: Released under the [MIT License](LICENSE).
- **Third-Party Components**:
  - The `qq-bridge` cognitive kernel, built-in DSH plugins, and visual management console are original works of this repository.
  - NapCatQQ is an independent open-source QQ protocol project unaffiliated with Tencent.
  - DeepSeek Harness is an independent open-source agent runtime.
- **Disclaimer**: This project is provided strictly for technical exchange, personal learning, and academic research. Please comply with local laws and platform terms of service. Any misuse for commercial fraud, spam, or harassment is strictly prohibited.
