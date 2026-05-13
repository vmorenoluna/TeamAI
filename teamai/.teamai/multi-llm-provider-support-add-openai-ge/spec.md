# Spec: Multi-LLM Provider Support — Add OpenAI, Gemini

## Problem
TeamAI's provider system only supports Anthropic, Bedrock, Vertex, and Ollama. Users cannot configure OpenAI or Google Gemini as providers, limiting flexibility.

## Requirements

### R1: Add OpenAI and Gemini to provider type
Add `openai` and `gemini` to the `provider` union type in `providers.ts`.

### R2: Set appropriate environment variables
- OpenAI: `OPENAI_API_KEY` (already standard)
- Gemini: `GOOGLE_API_KEY` (standard for Google AI)

### R3: Update provider config UI
Add OpenAI and Gemini options to the PROVIDERS list in `provider-config.tsx`.

### R4: Handle session opts
Map the new providers in `providerToSessionOpts()` to set appropriate env vars.

## Non-requirements
- No changes to Claude CLI (it only supports Anthropic models)
- These providers are for terminal sessions and potential future Claude CLI compatibility

## Acceptance Criteria
- [ ] `openai` and `gemini` are valid provider options
- [ ] Provider dropdown shows all 6 options
- [ ] No type errors
