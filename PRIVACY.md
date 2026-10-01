# LeakHalo Privacy Policy

Last updated: 2026-10-01

LeakHalo checks your public IPv4 and IPv6 addresses and approximate IP location. While the popup is open it checks IP addresses about every three seconds; background checks are scheduled about every 30 seconds when enabled. The extension sends HTTPS requests to Cloudflare, icanhazip, ipify, and Amazon Check IP for IP discovery, and to ipwho.is, GeoJS, or ipinfo.io for location and network metadata. Those providers receive your public IP address and normal request metadata under their own policies. LeakHalo does not send browsing history, page content, or analytics to its developer.

**Instant change detection (on by default).** To notice a changed IP within seconds, the extension keeps a small connection open to LeakHalo's own server (`35-232-61-175.sslip.io`, falling back to `35.232.61.175`). Like any server, it sees the public IP address the connection comes from, and it sends that IP back to the extension. The extension uses it only as a signal to re-check with the providers above; it is not shown or stored by the server. The server does not log or store IP addresses or any other personal data, has no account system, and receives nothing from the extension except periodic keep-alive messages. You can turn this off in Settings under Monitoring ("Instant change detection"); it is also off whenever automatic background checks are off.

The extension stores your latest IP and location results, settings, last check time, notification cooldown, and temporary provider rate-limit cooldowns in Chromium's local extension storage. It uses this data to show the popup, update the toolbar icon, and optionally alert you when your IP changes. It does not maintain a persistent history of IP addresses. A short-lived in-memory location cache can reuse results when you switch back to a recently used IP. You can remove local data by uninstalling the extension or clearing its extension storage.

When enabled, the shield changes Chromium's WebRTC IP handling policy through the browser `privacy` API. A separate setting can disable Chromium's network prediction. You can turn these features off in the popup or Settings. The WebRTC diagnostic may contact Google's STUN server at `stun.l.google.com:19302` while the popup is open and the shield is off. That server can see your public IP and normal request metadata.

LeakHalo has no user account, advertising, or analytics. Its only developer-operated service is the instant change detection server described above, which keeps no logs. Contact: slmn.labs.official@gmail.com
