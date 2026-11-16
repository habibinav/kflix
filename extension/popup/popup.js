// MovieHub Sync - Popup Script
// Updated to inform users about on-page controls

document.addEventListener('DOMContentLoaded', () => {
    const container = document.querySelector('.container');
    container.innerHTML = `
    <div class="header">
      <span class="logo">🎬</span>
      <h1>MovieHub Sync</h1>
    </div>
    
    <div style="text-align: center; padding: 20px 0;">
      <p style="color: rgba(255,255,255,0.7); margin-bottom: 16px; line-height: 1.5;">
        Go to a <strong>YouTube</strong>, <strong>Netflix</strong>, or other streaming site.
      </p>
      
      <p style="color: rgba(255,255,255,0.5); font-size: 12px;">
        You'll see floating controls in the bottom-right corner to create or join a room.
      </p>
    </div>
    
    <div style="
      background: rgba(139, 92, 246, 0.1);
      border: 1px solid rgba(139, 92, 246, 0.3);
      border-radius: 12px;
      padding: 12px;
      font-size: 12px;
      color: rgba(255,255,255,0.6);
    ">
      <strong style="color: #8b5cf6;">Supported sites:</strong><br>
      YouTube, Netflix, Prime Video, Disney+, Hotstar, HBO Max, Hulu
    </div>
  `;
});
