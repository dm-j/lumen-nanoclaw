# PrefixRouter Prompt-Cache Status

PrefixRouter (sister project, `~/Projects/PrefixRouter`; see the "Setting Lumen's Model" section of `CLAUDE.md` for the routing basics) exposes `POST /cache-status` so an agent can check whether a provider's prompt cache is still expected to be live for a session before deciding whether to keep growing context or truncate and rebuild it.

## Why this matters here

Provider prompt caching is per-model: switching from one model to another (including across a fallback chain) is a cache miss even if the previous model's cache is still warm. If a session's context has grown large and its cache has expired, continuing to append to it stops being "cheap" — a truncate-and-rebuild is likely cheaper than paying full price to extend a cold cache.

PrefixRouter doesn't manage what's in the prompt — it only reports whether the cache is *expected* to still be live, based on when it last saw a successful send for that session+model pair.

## Request

```
POST http://host.docker.internal:8787/cache-status
x-session-id: <arbitrary session identifier>
content-type: application/json

{ "model": "<routing-prefix>/<model-name>[=>fallback...]" }
```

- `model` may be a fallback chain, same `=>`-joined syntax used for `ncl groups config update --model`. PrefixRouter walks the chain left to right and answers for the first model that isn't circuit-open (i.e. the model that would actually receive the next real request).
- `x-session-id` should be the same identifier used to key an agent's session/conversation — it's an arbitrary string, PrefixRouter doesn't validate it against anything.

## Response

```json
{ "model": "ollama/deepseek-v4-flash:0731-cloud", "cache": "live" }
```

`cache` is `"live"` or `"expired"`. There's no separate "never sent" state — a session/model pair with no send history reads as `"expired"`, since there's nothing useful to distinguish for a caller deciding whether to truncate.

If no model in the chain is currently reachable (all circuit-open), PrefixRouter responds `503` instead of guessing — treat that the same as any other "can't reach a model" failure, not as a cache signal.

## How the timestamp gets set

Every time PrefixRouter successfully delivers a request for a `model` (an actual response, not a skipped/circuit-open link), it records `now` under that `(x-session-id, model)` pair — using the `x-session-id` header from the original inference request, not something you set separately. So sending inference through PrefixRouter with the same `x-session-id` you'll later query is enough to keep the timestamp current; no separate "mark as sent" call is needed.

TTL is per-provider (endpoint), configured in PrefixRouter's `config.json` as `cacheTtlMs` on the endpoint; if unset it defaults to 5 minutes.

## Consumer in this repo

`src/modules/projected-sessions/literal-tail.ts`'s `checkCacheStatus` calls this endpoint for the responder lane (real signal replaces the local `cacheTtlMs` TTL guess whenever the caller's model is known) — see the module's header comment for the compiler-vs-responder split.

## Caveats

- In-memory only, same as the circuit breaker — resets on PrefixRouter restart (`launchctl kickstart -k gui/$(id -u)/com.prefixrouter.server`). After a restart, everything reads `"expired"` until sends happen again, which is the correct answer, not a bug.
- This is advisory, not enforcement — PrefixRouter has no visibility into or control over what's actually in a request's context. It's purely a timestamp lookup against the provider's expected cache TTL.
