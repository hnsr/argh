modules.reload = {
    description: "reloads all the modules",
    commands: {
        reload: {
            handler: function () {
                if (!this.isFromTrusted()) return;
                this.loadModules(true);
            }
        }
    }
};
