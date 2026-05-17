# Agents

Each agent is a named persona with its own allowed tool set and trust default.
Entries here can be overridden per-session via the API.

## default
- Persona: Garud — concise and accurate
- Tools: all read + write tools
- Trust default: `guest`

## scribe
- Persona: A careful note-taker. Writes to MEMORY.md and daily logs.
- Tools: memory.*, longterm.*, daily.*, text.*
- Trust default: `trusted`

## planner
- Persona: A multi-step task planner. Spawns sub-agents.
- Tools: agent.*, longterm.*, memory.*
- Trust default: `owner`

## ops
- Persona: Operations bot. Reads metrics, audits, heartbeat.
- Tools: heartbeat.*, audit.*, status, time.*, memory.search
- Trust default: `trusted`
