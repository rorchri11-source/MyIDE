const { _electron: electron } = require('playwright');
const fs = require('fs');

(async () => {
  // Create a temporary directory to open
  const tmpDir = '/tmp/test_ide_folder';
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir);
  }
  fs.writeFileSync(tmpDir + '/test_file.txt', 'hello world');

  const electronApp = await electron.launch({ args: ['.'] });

  const window = await electronApp.firstWindow();

  let hasErrors = false;
  window.on('console', msg => {
    console.log('BROWSER CONSOLE:', msg.type(), msg.text());
    if (msg.type() === 'error' && !msg.text().includes('Content-Security-Policy')) {
      hasErrors = true;
    }
  });

  await window.waitForLoadState('domcontentloaded');

  await electronApp.evaluate(async ({ dialog }, dirPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [dirPath]
    });
  }, tmpDir);

  await new Promise(r => setTimeout(r, 1000));
  const helpModal = window.locator('#help-modal');
  if (await helpModal.isVisible()) {
    await window.locator('#btn-close-help').click();
  }

  console.log('Clicking open folder...');
  await window.locator('#btn-open-folder').click();

  await new Promise(r => setTimeout(r, 2000));

  console.log('Checking UI state...');
  const folderText = await window.locator('#current-folder').textContent();
  console.log('Current folder text:', folderText);
  if (folderText !== tmpDir) {
    console.error('Folder text mismatch');
    hasErrors = true;
  }

  const sidebarVisible = await window.locator('#sidebar').isVisible();
  console.log('Sidebar visible:', sidebarVisible);
  if (!sidebarVisible) {
    console.error('Sidebar not visible');
    hasErrors = true;
  }

  const fileTreeHtml = await window.locator('#file-tree').innerHTML();
  if (!fileTreeHtml.includes('test_file.txt')) {
    console.error('File tree does not contain test_file.txt');
    console.log('File tree HTML:', fileTreeHtml);
    hasErrors = true;
  } else {
    console.log('File tree contains test_file.txt');
  }

  await electronApp.close();

  if (hasErrors) {
    console.error('Test failed due to errors.');
    process.exit(1);
  } else {
    console.log('All checks passed successfully.');
  }
})();
