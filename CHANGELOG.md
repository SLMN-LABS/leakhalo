# Changelog

## 1.0.3

A review release: fixes from a full code and interface review of 1.0.2.

- The Settings page has an optional dark theme: choose Light, Dark or System under Appearance.
- Settings changed on two pages at the same time can no longer undo each other.
- IP change alerts are more reliable:
  - IPv4 and IPv6 changes in the same moment both arrive.
  - An alert Chrome failed to show is retried.
  - A restart never repeats an alert.
- On networks where one IP service stays silent for a long time, LeakHalo no longer keeps showing an old IPv4.
- The popup handles more situations clearly:
  - IPv6-only networks.
  - "Last known" when the IP services do not answer.
  - Offline, with no copy button where there is no address.
  - An unknown country, shown as unknown instead of "XX".
  - The city stays visible when map links are off.
  - "Tehran, Tehran" is shown once.
  - The WebRTC check never compares against stale IPs.
- The instant-detection connection is always encrypted.
- Better screen-reader labels.
- Requires Chrome 120 or newer.

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
