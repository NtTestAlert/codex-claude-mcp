# Persistent Agent SDK prototype benchmark

Three live samples on Windows, using Node 22.18.0, Claude Code 2.1.312, Agent
SDK 0.3.312, the `haiku` model and low effort. Each sample ran a short initial
prompt and a short follow-up with built-in tools and MCP servers disabled. This
compares controlled direct CLI calls against the SDK prototype, not the full MCP
request path: bridge config synchronization, locks, and host/UI latency are omitted.
The CLI path spawned a new Claude process for each turn; the SDK path kept one
Claude process alive for both turns. These are small, network-dependent samples,
not a statistically reliable performance comparison.

| Measurement | Sample 1 | Sample 2 | Sample 3 |
| --- | ---: | ---: | ---: |
| CLI initial turn: init / first text / process exit | 2715 / 4758 / 5563 ms | 2528 / 4422 / 5238 ms | 3216 / 6057 / 6917 ms |
| CLI follow-up: init / first text / process exit | 2795 / 5683 / 6460 ms | 2803 / 7682 / 8341 ms | 4953 / 7203 / 7892 ms |
| SDK initial turn: init / first text / result | 2574 / 4383 / 4412 ms | 2522 / 4623 / 4648 ms | 4080 / 6380 / 6414 ms |
| SDK warm follow-up: first text / result | 1557 / 1614 ms | 1721 / 1736 ms | 1555 / 1573 ms |
| CLI child peak RSS, initial / follow-up | 204 / 208 MiB | 207 / 209 MiB | 205 / 205 MiB |
| SDK child idle / peak RSS | 207 / 209 MiB | 207 / 211 MiB | 210 / at least 210 MiB |
| Benchmark controller RSS, CLI / after SDK import | not measured | 58 / 73 MiB | 58 / 66 MiB |
| SDK module import | not measured | not measured | 144 ms |

RSS is sampled working-set size for the direct Claude child only; it excludes
descendants. Controller RSS is for the benchmark process, not the MCP server.
The SDK result does not include process shutdown, while CLI elapsed time includes
process exit. Differences in model latency, network, prompt caching, SDK defaults
and environment can affect results. Use `npm run benchmark:sdk` for another run;
this consumes Claude usage. The benchmark currently requires a native CLI path.

The warm prototype is standalone and does not replace MCP ask/follow-up. Full
integration still needs validation of per-session locking across bridge processes,
configuration changes, permission rules, streaming, cleanup and recovery.
