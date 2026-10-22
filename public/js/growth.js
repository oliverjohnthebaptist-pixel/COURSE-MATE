(function () {
  const SITE_URL = 'https://coursematai.netlify.app';
  const COMMUNITY_URL = 'https://chat.whatsapp.com/CBBVsQ63aG29SaaAwtSKon?s=cl&p=a&mlu=0';
  const STORAGE_KEYS = {
    streak: 'coursemate_study_streak',
    popupNextAt: 'coursemate_community_popup_next_at'
  };
  const POPUP_INTERVAL = 5 * 60 * 1000;
  let popupTimer = null;

  function buildTodayKey(date) {
    return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
  }

  function readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.streak);
      if (!raw) return { days: [], currentStreak: 0, lastDate: '' };
      const parsed = JSON.parse(raw);
      return {
        days: Array.isArray(parsed.days) ? parsed.days.filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort() : [],
        currentStreak: Number(parsed.currentStreak) || 0,
        lastDate: typeof parsed.lastDate === 'string' ? parsed.lastDate : ''
      };
    } catch {
      return { days: [], currentStreak: 0, lastDate: '' };
    }
  }

  function writeState(state) {
    localStorage.setItem(STORAGE_KEYS.streak, JSON.stringify(state));
  }

  function getShareText({ label = 'study streak', added = '' } = {}) {
    const state = readState();
    const todaysStreak = getCurrentStreak(state.days);
    const text = added
      ? `${added} ${SITE_URL}`
      : `${todaysStreak ? `Day ${todaysStreak} of my CourseMate ${label}. ` : ''}I am learning with CourseMate today. ${SITE_URL}`;
    return text.trim();
  }

  function getCurrentStreak(days) {
    const activeDays = new Set(days || []);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = buildTodayKey(today);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = buildTodayKey(yesterday);
    let cursor = activeDays.has(todayKey) ? today : activeDays.has(yesterdayKey) ? yesterday : null;
    let streak = 0;

    while (cursor && activeDays.has(buildTodayKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
      if (streak >= 365) break;
    }

    return streak;
  }

  function recordActivity(activityLabel = 'study streak') {
    const today = buildTodayKey(new Date());
    const state = readState();
    const days = new Set(state.days || []);
    days.add(today);
    const list = Array.from(days).sort();
    const streak = getCurrentStreak(list);

    const next = {
      days: list,
      currentStreak: streak,
      lastDate: today,
      activityLabel
    };
    writeState(next);
    return next;
  }

  function shareToWhatsApp(text) {
    const finalText = text || getShareText();
    const shareUrl = `https://wa.me/?text=${encodeURIComponent(finalText)}`;
    window.open(shareUrl, '_blank', 'noopener,noreferrer');
  }

  function renderDashboardStreak() {
    const card = document.getElementById('studyStreakCard');
    if (!card) return;

    const state = readState();
    const currentStreak = getCurrentStreak(state.days);
    card.innerHTML = `
      <div data-streak-header>
        <div data-streak-copy>
          <div style="font-size:11px;color:#2AF598;font-weight:800;letter-spacing:0.08em;text-transform:uppercase">Study streak</div>
          <div style="font-size:clamp(22px,5vw,26px);font-weight:800;line-height:1.1;margin-top:8px;overflow-wrap:anywhere">${currentStreak ? `Day ${currentStreak}` : 'Start your streak'}</div>
          <div style="font-size:12px;color:#AABDB0;margin-top:6px;line-height:1.6">${currentStreak ? 'Keep the momentum going and share your progress.' : 'Complete a study task to record your first active study day.'}</div>
        </div>
        <div data-streak-count style="padding:8px 12px;border-radius:999px;background:#0B1A12;border:1px solid #1C3324;color:#2AF598;font-size:12px;font-weight:800">
          ${currentStreak} ${currentStreak === 1 ? 'day' : 'days'} active
        </div>
      </div>
      <div data-progress>
        <div style="grid-column:1/-1;color:#AABDB0;font-size:12px">Loading your study progress…</div>
      </div>
      <div data-streak-actions>
        <button type="button" data-share-streak disabled style="border:none;border-radius:10px;background:#2AF598;color:#05210F;padding:10px 14px;font-weight:800;cursor:pointer;opacity:.6">Share status</button>
        <button type="button" data-download-streak disabled style="border:1px solid #1C3324;background:transparent;color:#E8F5EC;padding:10px 14px;border-radius:10px;font-weight:700;cursor:pointer;opacity:.6">Download card</button>
      </div>
    `;

    let progressData = null;
    const shareBtn = card.querySelector('[data-share-streak]');
    const downloadBtn = card.querySelector('[data-download-streak]');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => {
        if (progressData) shareToWhatsApp(buildProgressShareText(progressData, currentStreak));
      });
    }
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        if (!progressData) return;
        downloadStatusCard({
          title: currentStreak ? `Day ${currentStreak} study streak` : 'My CourseMate study progress',
          detail: currentStreak
            ? `I have studied with CourseMate for ${currentStreak} ${currentStreak === 1 ? 'day' : 'days'} in a row.`
            : 'I am starting my study streak with CourseMate.',
          progress: progressData,
          streak: currentStreak
        });
      });
    }

    loadStudentProgress()
      .then(progress => {
        progressData = progress;
        renderProgressMetrics(card, progress, currentStreak);
        [shareBtn, downloadBtn].forEach(button => {
          if (button) {
            button.disabled = false;
            button.style.opacity = '1';
          }
        });
      })
      .catch(error => showProgressError(card, error));
  }

  async function loadStudentProgress() {
    const response = await fetch('/api/stats');
    let stats;
    try {
      stats = await response.json();
    } catch (error) {
      throw new Error('The progress service returned an unreadable response.');
    }
    if (!response.ok) {
      throw new Error(stats.error || `Could not load progress (HTTP ${response.status}).`);
    }
    return {
      materials: Number(stats.materials) || 0,
      summaries: Number(stats.summaries) || 0,
      tma: Number(stats.tma_solved) || 0,
      quizzes: Number(stats.quiz_attempts) || 0,
      averageScore: Number(stats.avg_score) || 0,
      aiChats: Number(stats.ai_chats) || 0
    };
  }

  function progressItems(progress, streak) {
    return [
      { label: 'Study streak', value: `${streak} ${streak === 1 ? 'day' : 'days'}` },
      { label: 'Materials uploaded', value: progress.materials },
      { label: 'Summary units', value: progress.summaries },
      { label: 'TMA answers', value: progress.tma },
      { label: 'Quiz attempts', value: progress.quizzes },
      { label: 'AI Tutor messages', value: progress.aiChats },
      { label: 'Average quiz score', value: `${progress.averageScore}%` }
    ];
  }

  function renderProgressMetrics(card, progress, streak) {
    const container = card.querySelector('[data-progress]');
    if (!container) return;
    container.innerHTML = progressItems(progress, streak).map(item => `
      <div style="background:#0B1A12;border:1px solid #1C3324;border-radius:12px;padding:12px">
        <div style="font-size:19px;font-weight:800;color:#2AF598">${item.value}</div>
        <div style="font-size:10px;color:#AABDB0;margin-top:4px">${item.label}</div>
      </div>
    `).join('');
  }

  function showProgressError(card, error) {
    console.error('Could not load the student progress summary.', error);
    const container = card.querySelector('[data-progress]');
    if (container) {
      container.innerHTML = `<div style="grid-column:1/-1;color:#ffb347;font-size:12px">Progress could not be loaded: ${escapeHTML(error.message)}</div>`;
    }
  }

  function buildProgressShareText(progress, streak) {
    const lines = progressItems(progress, streak).map(item => `${item.label}: ${item.value}`);
    return `My CourseMate study progress\n${lines.join('\n')}\n${SITE_URL}`;
  }

  function renderTaskShareCard({ title = 'Task complete', detail = '', label = 'Share my win' } = {}) {
    const target = document.getElementById('taskShareCard');
    if (!target) return;

    const text = `${detail} ${SITE_URL}`;
    target.style.display = 'block';
    target.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div data-task-copy>
          <div data-task-title style="font-size:11px;color:#2AF598;text-transform:uppercase;letter-spacing:0.08em;font-weight:800"></div>
          <div data-task-detail style="font-size:13px;color:#DDECE3;margin-top:6px;line-height:1.6"></div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button type="button" data-share-task style="border:none;border-radius:10px;background:#2AF598;color:#05210F;padding:10px 14px;font-weight:800;cursor:pointer">Share my win</button>
        <button type="button" data-download-task style="border:1px solid #1C3324;background:transparent;color:#E8F5EC;padding:10px 14px;border-radius:10px;font-weight:700;cursor:pointer">Download card</button>
      </div>
    `;

    target.querySelector('[data-task-title]').textContent = title;
    target.querySelector('[data-task-detail]').textContent = detail;
    target.querySelector('[data-share-task]').textContent = label;
    target.querySelector('[data-share-task]').addEventListener('click', () => shareToWhatsApp(text));
    target.querySelector('[data-download-task]').addEventListener('click', () => downloadStatusCard({ title, detail }));
  }

  function downloadStatusCard({ title = 'CourseMate study streak', detail = 'I am learning with CourseMate today.', progress = null, streak = 0 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 1400;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#06130C');
    gradient.addColorStop(1, '#112F20');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cardX = 120;
    const cardY = 160;
    const cardW = canvas.width - 240;
    const cardH = canvas.height - 260;
    ctx.fillStyle = '#0E2016';
    ctx.strokeStyle = '#2AF598';
    ctx.lineWidth = 4;
    roundRect(ctx, cardX, cardY, cardW, cardH, 40);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#2AF598';
    ctx.font = '700 46px Inter, Arial';
    ctx.fillText('CourseMate', cardX + 52, cardY + 92);

    ctx.fillStyle = '#F3FDF7';
    ctx.font = '800 58px Inter, Arial';
    const textX = cardX + 52;
    const textWidth = cardW - 120;
    const titleY = cardY + 235;
    const titleLines = wrapText(ctx, title || 'Study streak', textX, titleY, textWidth, 70, 2);

    ctx.font = '700 38px Inter, Arial';
    ctx.fillStyle = '#D9E7DE';
    const detailY = titleY + titleLines * 70 + 24;
    const detailLines = wrapText(ctx, detail || 'I am learning with CourseMate today.', textX, detailY, textWidth, 48, 3);

    if (progress) {
      const items = progressItems(progress, streak);
      const startY = Math.max(cardY + 560, detailY + detailLines * 48 + 40);
      const gap = 14;
      const boxWidth = (cardW - 120 - gap) / 2;
      const boxHeight = 96;
      items.forEach((item, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        const x = cardX + 52 + column * (boxWidth + gap);
        const y = startY + row * (boxHeight + gap);
        ctx.fillStyle = '#0B1A12';
        ctx.strokeStyle = '#1C3324';
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, boxWidth, boxHeight, 18);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#2AF598';
        ctx.font = '800 34px Inter, Arial';
        ctx.fillText(String(item.value), x + 22, y + 44, boxWidth - 44);
        ctx.fillStyle = '#AABDB0';
        ctx.font = '600 22px Inter, Arial';
        wrapText(ctx, item.label, x + 22, y + 76, boxWidth - 44, 26, 1);
      });
    }

    ctx.fillStyle = '#2AF598';
    ctx.font = '700 36px Inter, Arial';
    ctx.fillText('coursematai.netlify.app', textX, cardY + cardH - 65, textWidth);

    const anchor = document.createElement('a');
    anchor.download = 'coursemate-study-card.png';
    anchor.href = canvas.toDataURL('image/png');
    anchor.click();
  }

  function roundRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
  }

  function wrapText(context, text, x, y, maxWidth, lineHeight, maxLines = 6) {
    const words = String(text).trim().split(/\s+/);
    let line = '';
    let currentY = y;
    let lines = 0;

    for (let i = 0; i < words.length; i += 1) {
      const candidate = line ? `${line} ${words[i]}` : words[i];
      if (context.measureText(candidate).width > maxWidth && line) {
        if (lines >= maxLines - 1) {
          let clippedLine = line;
          while (clippedLine && context.measureText(`${clippedLine}…`).width > maxWidth) {
            clippedLine = clippedLine.slice(0, -1).trimEnd();
          }
          context.fillText(`${clippedLine}…`, x, currentY, maxWidth);
          return lines + 1;
        }
        context.fillText(line, x, currentY, maxWidth);
        line = words[i];
        currentY += lineHeight;
        lines += 1;
      } else {
        line = candidate;
      }
    }

    if (line.trim()) {
      context.fillText(line.trim(), x, currentY, maxWidth);
    }
    return lines + (line.trim() ? 1 : 0);
  }

  function openFeedbackModal() {
    const existing = document.getElementById('coursemate-feedback-modal');
    if (existing) {
      existing.remove();
    }

    const modal = document.createElement('div');
    modal.id = 'coursemate-feedback-modal';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.background = 'rgba(0,0,0,0.68)';
    modal.style.display = 'grid';
    modal.style.placeItems = 'center';
    modal.style.zIndex = '9999';
    modal.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="feedbackTitle" style="width:min(92vw, 520px);background:#0F1E15;border:1px solid #1C3324;border-radius:18px;padding:24px;color:#E8F5EC;box-shadow:0 30px 80px rgba(0,0,0,0.5)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px">
          <div>
            <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#2AF598;font-weight:800">Feedback</div>
            <h3 id="feedbackTitle" style="margin:8px 0 0;font-size:20px">Tell us what you think</h3>
          </div>
          <button type="button" data-close-feedback style="border:none;background:transparent;color:#E8F5EC;font-size:22px;cursor:pointer">×</button>
        </div>
        <p style="margin:0 0 12px;font-size:12px;color:#AABDB0;line-height:1.6">Your feedback will be sent privately to the CourseMate admin team for review.</p>
        <textarea id="feedbackText" rows="6" maxlength="5000" placeholder="Share what is working, what is confusing, or what you would love to see next..." style="width:100%;border:1px solid #1C3324;background:#08130D;color:#E8F5EC;border-radius:10px;padding:12px;resize:vertical;font:inherit"></textarea>
        <div data-feedback-status role="status" aria-live="polite" style="min-height:18px;margin-top:8px;font-size:12px;color:#AABDB0"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap">
          <button type="button" data-close-feedback style="border:1px solid #1C3324;background:transparent;color:#E8F5EC;padding:10px 14px;border-radius:10px;font-weight:700;cursor:pointer">Cancel</button>
          <button type="button" data-send-feedback style="border:none;background:#2AF598;color:#05210F;padding:10px 18px;border-radius:10px;font-weight:800;cursor:pointer">Send feedback</button>
        </div>
      </div>
    `;

    modal.querySelectorAll('[data-close-feedback]').forEach((button) => {
      button.addEventListener('click', () => modal.remove());
    });

    modal.querySelector('[data-send-feedback]').addEventListener('click', async event => {
      const button = event.currentTarget;
      const textarea = modal.querySelector('#feedbackText');
      const status = modal.querySelector('[data-feedback-status]');
      const message = textarea.value.trim();
      if (message.length < 3) {
        status.textContent = 'Please enter at least 3 characters of feedback.';
        status.style.color = '#ffb347';
        textarea.focus();
        return;
      }

      button.disabled = true;
      button.textContent = 'Sending…';
      status.textContent = 'Sending your feedback to the admin team…';
      status.style.color = '#AABDB0';
      try {
        const response = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        let result;
        try {
          result = await response.json();
        } catch (error) {
          throw new Error('The server returned an unreadable response. Please try again.');
        }
        if (!response.ok) throw new Error(result.error || `Could not send feedback (HTTP ${response.status}).`);
        status.textContent = 'Feedback sent to the admin team for review. Thank you.';
        status.style.color = '#2AF598';
        textarea.value = '';
      } catch (error) {
        console.error('Could not submit CourseMate feedback.', error);
        status.textContent = error.message || 'Feedback could not be sent. Please try again.';
        status.style.color = '#ff6b6b';
      } finally {
        button.disabled = false;
        button.textContent = 'Send feedback';
      }
    });

    document.body.appendChild(modal);
  }

  function openCommunityLink() {
    window.open(COMMUNITY_URL, '_blank', 'noopener,noreferrer');
  }

  function scheduleCommunityPopup(delay = POPUP_INTERVAL) {
    if (popupTimer) clearTimeout(popupTimer);
    popupTimer = setTimeout(showCommunityPopup, Math.max(0, delay));
  }

  function markCommunityPopupDismissed(popup) {
    try {
      const nextAt = Date.now() + POPUP_INTERVAL;
      localStorage.setItem(STORAGE_KEYS.popupNextAt, String(nextAt));
    } catch (error) {
      console.error('Could not save the community popup schedule.', error);
    }
    popup.remove();
    scheduleCommunityPopup(POPUP_INTERVAL);
  }

  function showCommunityPopup() {
    if (popupTimer) {
      clearTimeout(popupTimer);
      popupTimer = null;
    }
    try {
      const nextAt = Number(localStorage.getItem(STORAGE_KEYS.popupNextAt)) || 0;
      if (nextAt > Date.now()) {
        scheduleCommunityPopup(nextAt - Date.now());
        return;
      }
    } catch (error) {
      console.error('Could not read the community popup schedule.', error);
    }
    const existing = document.getElementById('coursemate-community-popup');
    if (existing) return;

    setTimeout(() => {
      const popup = document.createElement('div');
      popup.id = 'coursemate-community-popup';
      popup.style.position = 'fixed';
      popup.style.inset = '0';
      popup.style.background = 'rgba(4, 11, 9, 0.56)';
      popup.style.display = 'grid';
      popup.style.placeItems = 'center';
      popup.style.zIndex = '10000';
      popup.innerHTML = `
        <div role="dialog" aria-modal="true" aria-labelledby="communityTitle" style="width:min(90vw, 430px);background:#fff;border-radius:24px;padding:20px 20px 14px;box-shadow:0 30px 90px rgba(0,0,0,0.32);position:relative;text-align:center;color:#0d1d14">
          <button type="button" data-close-community style="position:absolute;top:12px;right:14px;border:none;background:transparent;font-size:28px;color:#22352e;cursor:pointer">×</button>
          <div style="display:grid;place-items:center;margin-bottom:8px">
            <img src="/logo.png" alt="CourseMate logo" width="72" height="72" style="width:72px;height:72px;object-fit:contain;border-radius:50%;background:#0d1d14;padding:4px">
          </div>
          <div style="font-size:12px;color:#22a06b;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;margin-top:8px">CourseMate</div>
          <h3 id="communityTitle" style="margin:10px 0 8px;font-size:28px;line-height:1.1;color:#102519">Join the CourseMate Student Community</h3>
          <p style="margin:0 0 18px;font-size:13px;line-height:1.7;color:#466256">Connect with other students, get quick study updates, and keep the momentum going together.</p>
          <button type="button" data-community-join style="display:block;width:100%;background:linear-gradient(135deg,#2AF598,#21b876);color:#05210F;border:none;border-radius:12px;padding:14px 18px;font-weight:900;font-size:15px;cursor:pointer">Join WhatsApp Community</button>
          <button type="button" data-close-community style="display:block;width:100%;margin-top:10px;background:#edf6f1;border:none;color:#102519;border-radius:12px;padding:12px 18px;font-weight:700;font-size:14px;cursor:pointer">Maybe later</button>
        </div>
      `;

      popup.querySelectorAll('[data-close-community]').forEach((button) => {
        button.addEventListener('click', () => {
          markCommunityPopupDismissed(popup);
        });
      });

      popup.querySelector('[data-community-join]').addEventListener('click', () => {
        markCommunityPopupDismissed(popup);
        openCommunityLink();
      });

      document.body.appendChild(popup);
    }, 600);
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderDashboardStreak();
    showCommunityPopup();
    document.querySelectorAll('[data-open-feedback]').forEach((button) => {
      button.addEventListener('click', openFeedbackModal);
    });
  });

  window.CourseMateGrowth = {
    recordActivity,
    getShareText,
    shareToWhatsApp,
    downloadStatusCard,
    renderDashboardStreak,
    renderTaskShareCard,
    openFeedbackModal,
    showCommunityPopup,
    loadStudentProgress,
    openCommunityLink,
    SITE_URL,
    COMMUNITY_URL
  };
})();
