# LeakHalo

**Know your IP. Catch the leaks.**

LeakHalo is a Chrome (Manifest V3) extension by SLMN LABS that shows the public IP address your browser connects from, where it appears to be, and whether Chrome's WebRTC protection is active.

- **Public IPv4 and IPv6** with country, city and network (ISP/ASN). IP geolocation is approximate.
- **Country flag in the toolbar**, or split flags when IPv4 and IPv6 leave from different countries.
- **Change alerts**: a desktop notification when your public IP changes.
- **WebRTC Armor**: applies Chrome's WebRTC IP-handling policy and shows whether Chrome reports it active. It does not replace a VPN, and other extensions or browser policy can override it.
- **Instant change detection** (optional, on by default): a small connection to LeakHalo's no-log server notices a changed IP within seconds.

## Install

- **Chrome Web Store:** coming soon.
- **From source:** open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select this folder. A welcome page opens on first install.

## Privacy

LeakHalo has no account, analytics or ads, and keeps results only in your browser. To find your IP it contacts the HTTPS services listed in the privacy policy, which receive your IP address, as any website does. Read the full policy: **[Privacy policy](https://slmn-labs.github.io/leakhalo/privacy.html)** ([source](PRIVACY.md)).

| Permission | Why |
|---|---|
| `storage` | Your settings and the latest result, stored locally |
| `privacy` | Apply Chrome's WebRTC IP-handling policy and the network prediction setting |
| `notifications` | Optional alert when your IP changes |
| `alarms` | Background checks about every 30 seconds |
| Listed IP and location services | Discover your public IP and its approximate location |

## Development

```sh
npm install
node test/run_tests.js        # static checks
node test/runtime_smoke.js    # background logic, including routing and notification rules
npx playwright-core install chromium
node test/e2e_browser.cjs     # loads the extension in real Chromium against local provider stand-ins
```

`node test/e2e_browser.cjs --live` also runs once against the real providers. To package for the store, zip `manifest.json`, `background/`, `popup/`, `options/`, `welcome/`, `assets/`, `privacy.html` and `privacy.css`.

## License

Source code and documentation © 2026 SLMN LABS, [MIT](LICENSE). Flag artwork and other third-party assets are credited in [ASSET_ATTRIBUTION.md](ASSET_ATTRIBUTION.md).

Contact: slmn.labs.official@gmail.com
