# CloudFront route for Seuss Cinema's restricted Wisp relay

This is an **optional** CDN/WebSocket route for the existing restricted relay:

```
Arcade (GitHub Pages) ── WSS ──> CloudFront ── HTTPS/WSS ──> seuss-cinema-arcade.onrender.com/wisp/
```

CloudFront **does not run Wisp or replace Render**. Render still handles the approved website origin checks, hostname allowlist, port restrictions, and WebSocket traffic. This does not affect locally hosted games or Supabase calling.

## Before deploying

- **Check AWS pricing and obtain account-owner approval.** AWS may charge for CloudFront requests/data transfer. Merely committing this file does **not** create an AWS distribution, connect an AWS account, or incur AWS usage charges.
- The site must be using the trusted origin `https://damonrosshutchins-boop.github.io`, which the Render Wisp service currently allows.
- The backend must remain available at `wss://seuss-cinema-arcade.onrender.com/wisp/`.

## Option A: Create a dedicated CloudFront distribution

1. In your AWS account, open **CloudFormation → Create stack → With new resources**.
2. Choose **Upload a template file**, and upload [cloudfront-wisp.yaml](./cloudfront-wisp.yaml). Review AWS's estimated cost before creating the stack.
3. After CloudFormation reports completion and the CloudFront distribution is **Deployed**, copy the **DistributionDomainName** stack output (such as `d1234567890abc.cloudfront.net`).
4. On the arcade, open **Settings → Hosting & player connection**, select **CloudFront**, paste that hostname, and click **Test connection**.
5. Only save the CloudFront setting if the test succeeds. Use **Render** as the fallback selection if it does not.

**Do not** paste access keys, account passwords, IAM keys, or secret tokens into the arcade settings. It needs only your public CloudFront distribution hostname.

## Option B: Use an existing CloudFront distribution

If you already have a distribution that serves other content, **do not create a second one just to try this**.

In that distribution, add a custom origin with these settings:

| Setting | Value |
| --- | --- |
| Origin domain | `seuss-cinema-arcade.onrender.com` |
| Origin protocol | **HTTPS only**, port 443 |
| Origin path | **empty** |
| Behavior path pattern | `wisp/*` (matches `/wisp/`) |
| Viewer protocol policy | **HTTPS only** |
| Allowed methods | **GET, HEAD, OPTIONS** |
| Cache policy | **CachingDisabled** |
| Origin request policy | **AllViewerExceptHostHeader** |
| Compression | Off |

CloudFront's **AllViewerExceptHostHeader** policy preserves the browser's `Origin` header and WebSocket handshake headers but uses the Render origin hostname for `Host`, avoiding TLS/host mismatches. Do not use a policy that strips `Origin`, `Sec-WebSocket-Key`, or `Sec-WebSocket-Version`. CloudFront WebSocket connections use HTTP/1.1.

Once deployed, enter your distribution's `d...cloudfront.net` hostname in the arcade Settings. It connects to `wss://YOUR-DISTRIBUTION.cloudfront.net/wisp/`.

## Verification / troubleshooting

- In the arcade settings, **Test connection** checks for a successful secure WebSocket handshake; this is **not** proof that a given third-party site or video stream will load.
- If the test fails, check the distribution's **Deployed** status, HTTPS origin, Origin request policy, and path. A CloudFront HTTP 502 can indicate HTTPS origin certificate/host mismatch. Ensure the Render origin hostname remains the HTTP `Host` value.
- The original Wisp service enforces its own **Origin allowlist and destination allowlist**, irrespective of CloudFront. Do not disable these safeguards or add `*/*` destinations.
- If the website is loaded from another host (such as a private preview), the relay may refuse that origin until explicitly approved.
- Switching providers reloads the arcade so Scramjet initializes using the selected Wisp URL.
- If the distribution is deleted or disabled later, select **Render** again in Settings.

Reference: [AWS WebSockets with CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html), [AWS managed origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html).
