# Changelog

## 1.0.2

- **Offline at a glance.**
  - A lost connection now shows within about a second as a grey toolbar icon, without text.
  - It also shows when Windows still reports a connection (VPN or virtual adapters, Wi-Fi without internet); before, this showed "ERR" and the last countries.
  - The return of the connection shows within seconds.
- **No host permissions.** LeakHalo reaches the IP services with standard cross-origin requests, so Chrome no longer warns that it can read and change data on those sites.
- **Time-zone hint** in the popup: warns when your browser's time zone does not match your IP's.
- **Settings:**
  - A separate switch for IPv6 change alerts.
  - Links to independent DNS-leak and fingerprint tests.

## 1.0.1

- Fixed: going offline, or using LeakHalo where its server is blocked, no longer fills the extension's error list on `chrome://extensions`. Instant detection now waits while the device is offline and checks that LeakHalo's server is reachable before connecting.

## 1.0.0 — first public release

- Public IPv4 and IPv6 with country, city and network; country flag in the toolbar, with split flags when IPv4 and IPv6 leave from different countries.
- IPv4 is checked from two independent vantage points at once (Cloudflare and ipify, with fallbacks), so the displayed IP is stable even when a network routes some destinations differently.
- Change alerts sent exactly once per real change.
- Instant change detection through LeakHalo's no-log server (can be turned off).
- WebRTC Armor and network prediction controls through Chrome's privacy API.
- Welcome page on first install with a live connection view and a guide to pinning LeakHalo.
