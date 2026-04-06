const { _electron: electron } = require('playwright');
const fs = require('fs');

(async () => {
  // First, modify the settings file directly
  const settingsPath = 'config/settings.json';
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
  if (!settings.preferences) settings.preferences = {};
  if (!settings.preferences.mcpServers) settings.preferences.mcpServers = {};

  const maliciousId = 'malicious" onmouseover="alert(\'xss\')" "';
  settings.preferences.mcpServers[maliciousId] = {
    name: "Malicious Server",
    command: "echo",
    args: []
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings));

  const electronApp = await electron.launch({ args: ['.'] });

  const window = await electronApp.firstWindow();
  await window.waitForSelector('#btn-settings', { timeout: 10000 });
  await window.waitForTimeout(2000); // Wait for modals to pop up

  // Close help modal if it's there
  try {
      await window.click('#btn-close-help', { timeout: 2000 });
      await window.waitForTimeout(1000);
  } catch(e) {}

  await window.click('#btn-settings');
  await window.waitForSelector('#settings-modal:not(.hidden)', { timeout: 5000 });
  await window.waitForTimeout(500);

  // Click MCP tab
  await window.click('[data-tab="mcp"]');
  await window.waitForTimeout(500);

  // Read the outer HTML of the remove button
  const buttonHtml = await window.evaluate(() => {
    const list = document.getElementById('mcp-servers-list');
    const buttons = list.querySelectorAll('.mcp-remove-btn');
    if (buttons.length > 0) {
      return buttons[0].outerHTML;
    }
    return null;
  });

  console.log("Button HTML:", buttonHtml);

  await window.screenshot({ path: '/home/jules/verification/mcp_xss.png' });

  await electronApp.close();
})();
