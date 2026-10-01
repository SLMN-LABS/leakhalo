# Changelog

## 1.0.0 — first public release

- Public IPv4 and IPv6 with country, city and network; country flag in the toolbar, with split flags when IPv4 and IPv6 leave from different countries.
- IPv4 is checked from two independent vantage points at once (Cloudflare and ipify, with fallbacks), so the displayed IP is stable even when a network routes some destinations differently.
- Change alerts sent exactly once per real change.
- Instant change detection through LeakHalo's no-log server (can be turned off).
- WebRTC Armor and network prediction controls through Chrome's privacy API.
- Welcome page on first install with a live connection view and a guide to pinning LeakHalo.
