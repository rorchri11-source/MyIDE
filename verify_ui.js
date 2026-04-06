const { _electron: electron } = require('playwright');

(async () => {
  const electronApp = await electron.launch({ args: ['.'] });
  const window = await electronApp.firstWindow();
  await window.waitForSelector('#btn-settings', { timeout: 10000 });
  await window.waitForTimeout(2000); // Wait for modals

  // Close help modal if it's there
  try {
      await window.click('#btn-close-help', { timeout: 2000 });
      await window.waitForTimeout(1000);
  } catch(e) {}

  // Create a fake token usage so display is visible
  await window.evaluate('document.getElementById("token-display").textContent = "1.5k tokens | 10%";');

  // Show token dashboard
  await window.click('#token-display');
  await window.waitForTimeout(1000);
  await window.screenshot({ path: '/home/jules/verification/token_dashboard.png' });

  await window.click('.token-dashboard-close');
  await window.waitForTimeout(1000);

  // Show chat history
  await window.click('#btn-chat-history');
  await window.waitForTimeout(1000);
  await window.screenshot({ path: '/home/jules/verification/chat_history.png' });

  await electronApp.close();
})();
