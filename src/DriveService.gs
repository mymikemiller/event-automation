function test_saveImageToDrive() {
  // Uses a small, stable public image for testing
  var testUrl = 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png';
  var result = saveImageToDrive(testUrl, 'Test Event', '2026-04-15');

  if (!result.fileId) throw new Error('No fileId returned');
  if (result.fileName !== '2026-04-15_Test-Event.png') {
    throw new Error('Unexpected filename: ' + result.fileName);
  }

  // Clean up: delete the test file
  DriveApp.getFileById(result.fileId).setTrashed(true);
  Logger.log('test_saveImageToDrive: ALL PASSED');
}

/**
 * Downloads an image from a URL and saves it to the configured Drive folder.
 * @param {string} imageUrl - Direct URL to the image
 * @param {string} eventTitle - Used to build the filename
 * @param {string} eventDate  - YYYY-MM-DD, used to build the filename
 * @returns {{fileId: string, fileName: string, fileUrl: string}|{error: string}}
 */
function saveImageToDrive(imageUrl, eventTitle, eventDate) {
  var folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');

  try {
    var response = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      return { error: 'Image URL returned HTTP ' + response.getResponseCode() };
    }

    var blob = response.getBlob();
    var mimeType = blob.getContentType() || 'image/jpeg';
    var ext = mimeType.split('/')[1] || 'jpg';
    // Normalize extension
    if (ext === 'jpeg') ext = 'jpg';

    var fileName = buildFilename(eventTitle, eventDate) + '.' + ext;
    blob.setName(fileName);

    var folder = DriveApp.getFolderById(folderId);
    var file = folder.createFile(blob);

    return {
      fileId: file.getId(),
      fileName: file.getName(),
      fileUrl: file.getUrl()
    };
  } catch (e) {
    return { error: 'Failed to save image: ' + e.message };
  }
}
