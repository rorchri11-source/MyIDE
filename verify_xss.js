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

  await window.click('#btn-settings');
  await window.waitForSelector('#settings-modal:not(.hidden)', { timeout: 5000 });
  await window.waitForTimeout(500);

  // Click MCP tab
  await window.click('[data-tab="mcp"]');
  await window.waitForTimeout(500);

  // Click Add MCP button
  await window.click('#btn-add-mcp');
  await window.waitForTimeout(500);

  // The code has a prompt('Server name ...'), but playwright can't interact with electron prompt easily if it's a synchronous prompt dialog,
  // Let's directly execute the JS instead to inject an MCP server with malicious ID

  await window.evaluate(() => {
    const maliciousId = 'malicious" onmouseover="alert(\'xss\')" "';
    const settings = window.app.settings;
    const prefs = settings.getPreferences();
    const updated = prefs.mcpServers || {};
    updated[maliciousId] = { name: 'malicious', command: 'test', args: [] };
    settings.setPreferences({ mcpServers: updated });
    app.updateMCPTab();
  });

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
