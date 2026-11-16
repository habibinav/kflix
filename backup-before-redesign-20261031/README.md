# MovieHub

Upload a browser-compatible movie to one shared server and watch it with one friend. The host controls play, pause and seeking; the guest can click the video to allow playback when their browser blocks autoplay. Chat, reactions and SRT/VTT subtitles remain available.

## Run

Requires Node.js 18 or later.

```sh
npm ci
npm start
```

Open http://localhost:3000, create a room, choose a movie, and wait for the upload progress to finish. Share the room link with your friend. Uploads are streamed to disk rather than buffered in RAM; both browsers request the same uploaded file with HTTP byte ranges for seeking. Playback starts after the upload completes. The default upload limit is 20 GiB.

Use MP4 containing H.264 video and AAC audio, or a WebM supported by both browsers. File extensions alone do not guarantee compatible codecs. MKV/HEVC and other unsupported files require conversion outside this app; there is no built-in transcoding. No zero-lag or zero-upload-time guarantee is possible.

## Different locations

Both users must open the **same internet-accessible HTTPS URL**. localhost works only on your own computer. Deploy this Node server behind an HTTPS reverse proxy, or use an HTTPS tunnel for testing. Forward Socket.IO/WebSocket traffic, allow large request bodies, and increase upload/read timeouts for movie-sized transfers. Keep the server process running and use a single instance: room state is held in memory.

Example nginx location settings (configure TLS separately):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    client_max_body_size 20G;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_body_timeout 3600s;
}
```

Environment variables are read from the process environment; `.env` files are not loaded automatically:

- `PORT`: default 3000.
- `JWT_SECRET`: set a long random stable value on a deployed server.
- `MAX_UPLOAD_BYTES`: positive byte limit, default 21474836480.

Movies use the operating system temporary directory. Allow enough disk space for concurrent uploads. Files are removed when a host's room expires (30 seconds after disconnection), when replaced, or on normal process exit. Restarting loses rooms and interrupted uploads cannot resume. Abrupt termination may leave temporary `moviehub-*` directories requiring cleanup. Anyone holding a movie's generated media URL can access it while its room exists; keep links private. This is a small private two-person app, without public-service quotas or account management.

## Recovery and sync

A socket reconnect attempts to restore its room for 30 seconds, using its existing signed identity. The server stores the host timeline, gives it to late joiners, and broadcasts corrections every five seconds while playing. Only the host can publish timeline changes or upload. Upload failures display a retry message. Upload progress and completion are distinct from codec compatibility.

## Optional legacy extension

The `extension/` folder is separate from uploaded-file watching and is not required for it. It still has an old hardcoded ngrok URL in `background.js`; that extension is not configured or validated by this repair. Its streaming-site features also depend on the site's own playback restrictions. The web upload path no longer uses WebRTC or TURN. The legacy server ICE endpoint accepts explicit `TURN_URL` plus `TURN_USER`/`TURN_PASS`, or `TURN_URL` plus `TURN_SECRET` for coturn shared-secret authentication; it no longer advertises unverified public TURN fallbacks.

## Validation

```sh
npm test
```

Integration tests use two Socket.IO polling clients and HTTP requests to check upload authorization and limits, seekable range responses, private media URLs, late joining, play/pause state, guest control rejection, reconnect recovery, room capacity and malformed requests. Browser-state tests check shared source loading, pending metadata synchronization, autoplay handling and guest seek restrictions. Real audiovisual playback on two separate networks still needs a manual check with an actual compatible movie and deployed HTTPS URL.
