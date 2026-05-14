App({
  onLaunch() {
    const sysInfo = this._readSystemInfo();
    this.globalData = Object.assign(this.globalData || {}, sysInfo);
  },
  _readSystemInfo() {
    let device = {};
    let window = {};
    let app = {};
    try {
      device = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
    } catch (e) {}
    try {
      window = wx.getWindowInfo ? wx.getWindowInfo() : {};
    } catch (e) {}
    try {
      app = wx.getAppBaseInfo ? wx.getAppBaseInfo() : {};
    } catch (e) {}
    if (!device.pixelRatio || !window.windowWidth) {
      try {
        const legacy = wx.getSystemInfoSync();
        device = Object.assign({}, legacy, device);
        window = Object.assign({}, legacy, window);
        app = Object.assign({}, legacy, app);
      } catch (e) {}
    }
    const pixelRatio = device.pixelRatio || 2;
    const windowWidth = window.windowWidth || 375;
    const windowHeight = window.windowHeight || 667;
    const screenWidth = window.screenWidth || windowWidth;
    const statusBarHeight = window.statusBarHeight || 20;
    const safeArea = window.safeArea || {
      top: statusBarHeight,
      left: 0,
      right: windowWidth,
      bottom: windowHeight,
      width: windowWidth,
      height: windowHeight - statusBarHeight
    };
    const safeBottom = Math.max(0, windowHeight - safeArea.bottom);
    const theme = (app && app.theme) || 'light';
    return {
      pixelRatio,
      windowWidth,
      windowHeight,
      screenWidth,
      statusBarHeight,
      safeArea,
      safeBottom,
      theme
    };
  },
  globalData: {
    pixelRatio: 2,
    windowWidth: 375,
    windowHeight: 667,
    screenWidth: 375,
    statusBarHeight: 20,
    safeBottom: 0,
    theme: 'light'
  }
});
