const { _electron: electron } = require('playwright');

(async () => {
  const electronApp = await electron.launch({ args: ['.'] });

  const window = await electronApp.firstWindow();
  await window.waitForSelector('#btn-settings', { timeout: 10000 });
  await window.waitForTimeout(2000); // Wait for modals to pop up

  // Close help modal if it's there
  try {
      await window.click('#btn-close-help', { timeout: 2000 });
      await window.waitForTimeout(1000);
  } catch(e) {}

  await window.screenshot({ path: '/home/jules/verification/main_screen.png' });

  await window.click('#btn-settings');
  await window.waitForSelector('#settings-modal:not(.hidden)', { timeout: 5000 });
  await window.waitForTimeout(500);
  await window.screenshot({ path: '/home/jules/verification/settings_modal.png' });

  await window.click('#btn-close-settings');
  await window.waitForTimeout(500);

  // Try to toggle terminal
  await window.keyboard.press('Control+Shift+T');
  await window.waitForSelector('#terminal-panel', { timeout: 5000 });
  await window.waitForTimeout(500);
  await window.screenshot({ path: '/home/jules/verification/terminal_panel.png' });

  await electronApp.close();
})();
