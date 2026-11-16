# Kflix

A screening room for two. Drop a film from your computer and it starts playing immediately. Your friend, somewhere else, watches it with you in sync.

## How it works

The movie never goes to the server.

1. **You drop a file.** It plays from your disk through a local object URL, so the first frame shows up in tens of milliseconds whatever the file size.
2. **Your friend gets a live stream.** Your browser captures the playing `<video>` and sends it to theirs over WebRTC (peer to peer, VP9 preferred, up to about 8 Mb/s). They're watching within a second of joining.
3. **Or they use their own copy.** If they have the same file (matched by exact size), they drop it in. Each of you then plays your own copy at full quality, and their player follows your clock: a small playback-rate nudge for drift under about a second, a seek for anything larger. Measured drift in testing stayed under 100 ms.

Either person can play, pause or seek. The other side follows, and a short note shows who did it. Chat, subtitles (.srt and .vtt, shared with both of you) and reconnect handling are included. If you reload the page, the room keeps your seat and the timestamp; drop the file again to continue.

## Subtitles

Click the CC button or press S to open the subtitles panel.

- **Load:** pick an .srt, .vtt or .ass/.ssa file, or drop one onto the screen. Both of you get the track. Older .srt files saved as Windows-1252 decode correctly, so accents don't turn into garbage.
- **Timing:** if the lines come too early or too late, nudge them by 0.1 s or 0.5 s, or press G and H. The correction is shared, and clicking the value resets it.
- **Show, size and style:** on/off, S to XL, and outline, box or yellow. These are per person and remembered.

Subtitles built into the video file (for example inside an MKV) can't be read by the browser. Use a separate file. You can extract one with `ffmpeg -i film.mkv -map 0:s:0 subs.srt`.

Keys: Space or K to play/pause, ← and → to skip 10 seconds, F for fullscreen, M to mute, C for chat, S for subtitles, G and H to shift subtitle timing.

## Posters

The lobby shows a wall of film posters in random order, drifting slowly. When you drop a film, Kflix looks up its artwork from the title in the filename (e.g. `The.Matrix.1999.1080p.mkv` becomes "The Matrix", 1999). The blurred backdrop sits behind the player, and pausing shows the poster, title and synopsis.

The artwork comes from [TMDB](https://www.themoviedb.org/). To turn it on:

1. Create a free account at themoviedb.org → Settings → API → request an API key (choose "Personal" use).
2. Copy `.env.example` to `.env` and paste the key into `TMDB_API_KEY`. The longer "API Read Access Token" works too, as `TMDB_READ_TOKEN`.
3. Restart `npm start`.

Without a key everything else works the same. The lobby wall shows film titles set in type instead of posters. TMDB's terms ask for the attribution line the lobby shows, and they allow non-commercial use.

## Run

Requires Node.js 18 or later.

```sh
npm install
npm start
```

Open http://localhost:3000.

## Watching from two different places

Both people need to open the same URL, so the server has to be reachable from the internet. Because the film doesn't pass through the server, a small free host is enough.

- **Quick test:** run `npm start`, then expose it with a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, and send your friend the HTTPS link.
- **Permanent:** deploy to Render, Railway or Fly.io (WebSocket support needed). Set `JWT_SECRET` to a long random value so identities survive restarts. Use a single instance, because rooms are held in memory.

### TURN (when it's stuck on "Connecting")

The stream goes directly from one browser to the other. That usually works on home Wi-Fi. It often fails when one of you is on **mobile data, a hotspot, or college or office Wi-Fi**. Those networks hide many devices behind one address, so the two browsers can't find each other. Kflix then tells your friend after about 15 seconds instead of spinning forever.

The fix is a TURN relay, a server that passes the stream along when a direct path doesn't work. Cloudflare's is free for the first 1,000 GB a month, which is roughly 150 films at Kflix's quality:

1. Sign up at dash.cloudflare.com (free), then open **Realtime** (it may be listed as **Calls**) → **TURN Server** → **Create**.
2. It shows a **Turn Token ID** and an **API Token**. Add them to `.env`:
   ```
   CLOUDFLARE_TURN_KEY_ID=your-token-id
   CLOUDFLARE_TURN_API_TOKEN=your-api-token
   ```
3. Restart `npm start`. The startup message should say `relay: on`.

Kflix only uses the relay when a direct connection fails, so home-to-home viewing doesn't use your quota.

You can also skip the relay: if your friend has the same file, they click "Use your copy", which needs no media connection at all.

Any other TURN server works too (coturn, Metered, Twilio):
- `TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349`
- plus either `TURN_USER` and `TURN_PASS`, or `TURN_SECRET` for coturn's shared-secret auth.

If it still won't connect, open the browser console (Cmd+Option+J). Kflix logs which connection types each side found. `local candidates: host` with no `srflx` means the network is blocking even the basic address lookup.

## File formats

The browser does the decoding, so use what browsers can play:

- **Plays everywhere:** MP4 (H.264 video, AAC audio), WebM (VP9/AV1, Opus).
- **Chrome and Edge:** MKV works when the video inside is H.264 or VP9.
- **Needs converting:** HEVC/x265 in most browsers, and DTS/AC3 audio. To convert: `ffmpeg -i in.mkv -c:v libx264 -crf 20 -c:a aac out.mp4`. If the video is already H.264, `-c:v copy` is much faster.

## Browsers

The person playing from disk should use **Chrome, Edge or Firefox**. Safari can't capture a video element for streaming. A Safari user can still join, and if they have their own copy, drop it in. Viewers can use any modern browser.

## Configuration

- `PORT`: default 3000.
- `JWT_SECRET`: signs the anonymous identity tokens. Random per start if unset.
- `TMDB_API_KEY` or `TMDB_READ_TOKEN`: enables posters and artwork.
- `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`: free Cloudflare relay (see TURN above).
- `TURN_URL`, `TURN_USER`, `TURN_PASS`, `TURN_SECRET`: any other TURN server.

Any of these can go in a `.env` file next to `server.js`.

## Tests

```sh
npm test
```

These cover the room protocol (identity, late join, stream/local modes, shared control, source-only clock, signaling relay, chat, capacity, reconnect, source leaving) and check that every element and icon the client uses exists in the page.

The `extension/` folder is an older, separate experiment and is not used by the web app.
