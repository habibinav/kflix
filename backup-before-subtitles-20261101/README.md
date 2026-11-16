# Kflix

A screening room for two. Drop a film from your computer and it starts playing immediately. Your friend, somewhere else, watches it with you in sync.

## How it works

The movie never goes to the server.

1. **You drop a file.** It plays from your disk through a local object URL, so the first frame shows up in tens of milliseconds whatever the file size.
2. **Your friend gets a live stream.** Your browser captures the playing `<video>` and sends it to theirs over WebRTC (peer to peer, VP9 preferred, up to about 8 Mb/s). They're watching within a second of joining.
3. **Or they use their own copy.** If they have the same file (matched by exact size), they drop it in. Each of you then plays your own copy at full quality, and their player follows your clock: a small playback-rate nudge for drift under about a second, a seek for anything larger. Measured drift in testing stayed under 100 ms.

Either person can play, pause or seek. The other side follows, and a short note shows who did it. Chat, subtitles (.srt and .vtt, shared with both of you) and reconnect handling are included. If you reload the page, the room keeps your seat and the timestamp; drop the file again to continue.

Keys: Space or K to play/pause, ← and → to skip 10 seconds, F for fullscreen, M to mute, C for chat.

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

### TURN (when the stream won't connect)

WebRTC connects directly between the two browsers. On most home and mobile networks that just works using the public STUN servers. Some strict networks (corporate, some campus Wi-Fi, symmetric NAT) block direct connections. You'll see "Couldn't open a direct connection" in that case. You have two fixes:

- The friend drops their own copy, which needs no media connection at all.
- Or configure a TURN relay (coturn, or a hosted one such as Metered or Twilio):
  - `TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349`
  - plus either `TURN_USER` and `TURN_PASS`, or `TURN_SECRET` for coturn's shared-secret auth.

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
- `TURN_URL`, `TURN_USER`, `TURN_PASS`, `TURN_SECRET`: see above.

Any of these can go in a `.env` file next to `server.js`.

## Tests

```sh
npm test
```

These cover the room protocol (identity, late join, stream/local modes, shared control, source-only clock, signaling relay, chat, capacity, reconnect, source leaving) and check that every element and icon the client uses exists in the page.

The `extension/` folder is an older, separate experiment and is not used by the web app.
