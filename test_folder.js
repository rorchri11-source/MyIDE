const { _electron: electron } = require('playwright');

(async () => {
  const electronApp = await electron.launch({ args: ['.'] });

  // Evaluation expression in the Electron context.
  const appPath = await electronApp.evaluate(async ({ app }) => {
    return app.getAppPath();
  });
  console.log('App path:', appPath);

  // Get the first window that the app opens
  const window = await electronApp.firstWindow();

  // Setup console listener
  window.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));

  // Wait for it to be ready
  await window.waitForLoadState('domcontentloaded');

  // Override dialog.showOpenDialog in the main process to mock folder selection
  await electronApp.evaluate(async ({ dialog }) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: ['/tmp']
    });
  });

  // Wait a bit to ensure #help-modal is displayed (if it's delayed)
  await new Promise(r => setTimeout(r, 1000));

  // Close the help modal if present
  const helpModal = window.locator('#help-modal');
  if (await helpModal.isVisible()) {
    await window.locator('#btn-close-help').click();
  }

  // Click the open folder button
  await window.locator('#btn-open-folder').click();

  // Wait a bit
  await new Promise(r => setTimeout(r, 2000));

  await electronApp.close();
})();
