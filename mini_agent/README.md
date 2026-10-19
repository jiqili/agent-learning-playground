# Mini Agent

## Tests

Run unit tests with `npm test` from this directory.

For real-model integration tests, configure `OPENROUTER_API_KEY` and
`OPENROUTER_MODEL` in the local `.env` file, then run `npm run test:integration`.
The tests call OpenRouter directly; no local backend is required. Do not commit
the environment file.
The integration command uses Node.js native environment proxy support
(`--use-env-proxy`), honoring `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.

## Model configuration

Pass `backendUrl`, `apiKey`, and `model` to the `Agent` constructor to call a
model provider directly. `backendUrl` is the base URL before
`/v1/chat/completions` (for OpenRouter, `https://openrouter.ai/api`).
Both normal completions and compaction requests use these options.
Without these options, the existing local proxy default remains available.

## Console output

Tool result logs show at most 500 characters of content, followed by a truncation
notice for longer results. Full results remain available to lifecycle callbacks
and in model context. Compaction start and completion logs show the strategy,
message counts, and context character counts (not token counts).

Per-message compaction produces a brief retrieval summary (a prompt target of
300 characters, up to 500 when needed), preserving execution and pagination
state. The archive reference is appended separately. Already archived messages
are skipped even if their summaries exceed the compaction trigger threshold.

## File reading

`read_file` accepts a 1-based `offset` (default 1) and `limit` (default and
maximum 1000). Each page contains at most 1000 complete lines or 25 KiB of
UTF-8 file content, whichever is reached first. JSON metadata is additional
to the content budget. Original line endings are preserved.
The JSON result includes `content`, `offset`, `limit`, `linesRead`,
`bytesRead`, `eof`, and `next`. Continue with `next.offset` and `next.limit`
on the same file until `next` is null. A single line exceeding 25 KiB
produces an explicit error rather than silently dropping part of the line.
