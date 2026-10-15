const escapePaymentHTML = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('submissions').addEventListener('click', handlePaymentAction);
  loadPaymentSubmissions();
});

async function loadPaymentSubmissions() {
  const panel = document.getElementById('adminReview');
  const status = document.getElementById('adminStatus');
  const list = document.getElementById('submissions');
  try {
    const response = await fetch('/api/admin/payments');
    const result = await response.json();
    if (response.status === 403) return;
    if (!response.ok) throw new Error(result.error || 'Could not load payment submissions.');
    panel.style.display = 'block';
    if (!result.submissions.length) {
      status.textContent = 'No payment submissions yet.';
      return;
    }
    status.textContent = `${result.submissions.length} payment submission${result.submissions.length === 1 ? '' : 's'}.`;
    list.innerHTML = result.submissions.map(submission => `<article class="submission" data-submission="${escapePaymentHTML(submission.id)}">
      <div style="font-size:17px;font-weight:800">${escapePaymentHTML(submission.name || 'Student')}</div>
      <div class="muted">${escapePaymentHTML(submission.email || '')} · Submitted ${new Date(submission.created_at).toLocaleString()}</div>
      <div class="muted" style="margin-top:6px">Status: <b>${escapePaymentHTML(submission.status)}</b></div>
      <div class="row">
        ${submission.has_receipt ? '<button class="secondary" type="button" data-action="receipt">View receipt</button>' : ''}
        ${submission.code ? `<span class="code">Activation code: ${escapePaymentHTML(submission.code)}</span>` : submission.status === 'pending' ? '<button class="primary" type="button" data-action="approve">Approve & generate code</button>' : ''}
      </div>
      <iframe class="receipt-preview" title="Payment receipt"></iframe>
    </article>`).join('');
  } catch (error) {
    status.textContent = error.message;
    list.replaceChildren();
  }
}

async function handlePaymentAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('[data-submission]');
  const action = button.dataset.action;
  const id = card.dataset.submission;
  button.disabled = true;
  try {
    if (action === 'receipt') await showReceipt(card, id, button);
    if (action === 'approve') await approvePayment(id);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function showReceipt(card, id, button) {
  const frame = card.querySelector('.receipt-preview');
  if (frame.style.display === 'block') {
    frame.style.display = 'none';
    button.textContent = 'View receipt';
    return;
  }
  const response = await fetch(`/api/admin/payments/${encodeURIComponent(id)}/receipt`);
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || 'Could not open payment receipt.');
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const result = await response.json();
    if (!result.url) throw new Error('Could not open payment receipt.');
    frame.src = result.url;
  } else {
    if (frame.dataset.objectUrl) URL.revokeObjectURL(frame.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(await response.blob());
    frame.dataset.objectUrl = objectUrl;
    frame.src = objectUrl;
  }
  frame.style.display = 'block';
  button.textContent = 'Hide receipt';
}

async function approvePayment(id) {
  const response = await fetch(`/api/admin/payments/${encodeURIComponent(id)}/activate`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not generate activation code.');
  alert(`Payment approved. Activation code: ${result.code}\nSend this code to the student.`);
  await loadPaymentSubmissions();
}
