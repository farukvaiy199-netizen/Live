// Khan Sports Studio — RTMP রিলে সার্ভার
// কাজ: ব্রাউজার থেকে WebSocket-এ আসা ভিডিও/অডিও ডেটা নিয়ে ffmpeg দিয়ে
// আসল RTMP-তে কনভার্ট করে YouTube/Facebook-এ পাঠায়।

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
// নিরাপত্তার জন্য একটা গোপন টোকেন — Render-এ Environment Variable হিসেবে RELAY_TOKEN সেট করবেন,
// তারপর অ্যাপের "রিলে সার্ভার" URL-এ ?token=... হিসেবে একই টোকেন বসাবেন।
// খালি রাখলে (সেট না করলে) টোকেন-যাচাই বন্ধ থাকবে — টেস্টের জন্য ঠিক আছে, প্রকৃত ব্যবহারে টোকেন সেট করা ভালো।
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Khan Sports Studio RTMP Relay চলছে ✅');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') || '';

  if (RELAY_TOKEN && token !== RELAY_TOKEN) {
    ws.send(JSON.stringify({ type: 'error', message: 'ভুল টোকেন — অ্যাক্সেস বাতিল করা হলো।' }));
    ws.close();
    return;
  }

  console.log('[relay] নতুন ক্লায়েন্ট কানেক্ট হয়েছে');
  let ffmpegProcess = null;

  ws.on('message', (data, isBinary) => {
    // প্রথম টেক্সট মেসেজ (JSON) দিয়ে শুরু/বন্ধ নিয়ন্ত্রণ করা হয়, বাকি সব বাইনারি ভিডিও ডেটা
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }

      if (msg.type === 'start') {
        if (ffmpegProcess) return; // আগে থেকেই চলছে
        const rtmpTarget = msg.rtmpUrl;
        if (!rtmpTarget || !rtmpTarget.startsWith('rtmp')) {
          ws.send(JSON.stringify({ type: 'error', message: 'RTMP URL ঠিক নেই।' }));
          return;
        }

        console.log('[relay] ffmpeg শুরু হচ্ছে →', rtmpTarget.replace(/\/[^/]+$/, '/***'));
        ffmpegProcess = spawn('ffmpeg', [
          '-fflags', '+genpts+igndts',
          '-analyzeduration', '5000000',
          '-probesize', '5000000',
          '-re',
          '-i', 'pipe:0',
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-tune', 'zerolatency',
          '-b:v', '2500k',
          '-maxrate', '2500k',
          '-bufsize', '5000k',
          '-pix_fmt', 'yuv420p',
          '-g', '60',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2',
          '-f', 'flv',
          rtmpTarget
        ]);

        ffmpegProcess.stderr.on('data', (d) => {
          // ffmpeg নিজের লগ stderr-এ পাঠায়, এটা এরর না — ডিবাগের জন্য দরকারি
          console.log('[ffmpeg]', d.toString().slice(0, 300));
        });
        ffmpegProcess.on('error', (err) => {
          console.error('[relay] ffmpeg চালু করা যায়নি:', err.message);
          ws.send(JSON.stringify({ type: 'error', message: 'সার্ভারে ffmpeg পাওয়া যায়নি বা চালু করা যায়নি।' }));
        });
        ffmpegProcess.on('close', (code) => {
          console.log('[relay] ffmpeg বন্ধ হয়েছে, কোড:', code);
          ffmpegProcess = null;
          try { ws.send(JSON.stringify({ type: 'ended', code })); } catch (e) {}
        });

        ws.send(JSON.stringify({ type: 'started' }));
      }

      if (msg.type === 'stop') {
        if (ffmpegProcess) {
          try { ffmpegProcess.stdin.end(); } catch (e) {}
          ffmpegProcess.kill('SIGINT');
          ffmpegProcess = null;
        }
      }
      return;
    }

    // বাইনারি ভিডিও/অডিও চাংক — সরাসরি ffmpeg-কে পাইপ করে দেওয়া হয়
    if (ffmpegProcess && ffmpegProcess.stdin.writable) {
      ffmpegProcess.stdin.write(data);
    }
  });

  ws.on('close', () => {
    console.log('[relay] ক্লায়েন্ট ডিসকানেক্ট');
    if (ffmpegProcess) {
      try { ffmpegProcess.stdin.end(); } catch (e) {}
      ffmpegProcess.kill('SIGINT');
      ffmpegProcess = null;
    }
  });

  ws.on('error', (e) => console.error('[relay] ws error:', e.message));
});

server.listen(PORT, () => {
  console.log(`[relay] Khan Sports Studio RTMP রিলে সার্ভার চালু, পোর্ট ${PORT}`);
});
