App({
  onLaunch() {
    const sysInfo = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    this.globalData = {
      pixelRatio: sysInfo.pixelRatio || 2
    };
  },
  globalData: {
    pixelRatio: 2
  }
});
