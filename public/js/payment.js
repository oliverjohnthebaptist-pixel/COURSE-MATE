document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('paymentProofForm').addEventListener('submit', submitPaymentProof);
  document.getElementById('activationForm').addEventListener('submit', activateStarter);
  loadPaymentStatus();
});

async function submitPaymentProof(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById('studentStatus');
  button.disabled = true;
  status.textContent = 'Submitting your payment proof…';
  try {
    const receipt = form.querySelector('input[type="file"]')?.files?.[0];
    if (!receipt) throw new Error('Choose your payment receipt first.');
    const response = await window.cmUploadReceipt(receipt);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not submit payment proof.');
    form.reset();
    status.textContent = 'Payment proof submitted. Your transfer is awaiting review.';
    await loadPaymentStatus();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadPaymentStatus() {
  const status = document.getElementById('studentStatus');
  try {
    const response = await fetch('/api/pay/manual-submissions');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load payment status.');
    const latest = (result.submissions || [])[0];
    if (!latest) return;
    if (latest.status === 'pending') status.textContent = `Your payment proof submitted ${new Date(latest.created_at).toLocaleString()} is awaiting review.`;
    if (latest.status === 'approved' && latest.code) status.textContent = `Payment approved. Your activation code is ${latest.code}. Enter it below to activate Starter.`;
  } catch (error) {
    status.textContent = error.message;
  }
}

async function activateStarter(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const status = document.getElementById('activationStatus');
  button.disabled = true;
  status.textContent = 'Checking activation code…';
  try {
    const response = await fetch('/api/pay/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: document.getElementById('activationCode').value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not activate Starter.');
    localStorage.setItem('user_plan', 'starter');
    status.textContent = 'Starter is active. Returning to your dashboard…';
    location.href = '/dashboard.html';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
