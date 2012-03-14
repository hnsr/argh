// Code for kick handling 
modules.autorejoin = {
    description: 'Auto rejoin after kick',
    hooks: {
        userUpdate: function (nickname, type, newName, channel, message) {
            if (type == "kick" && nickname == this.client.nickname) {
                this.log("Got kicked by " + newName + " from channel " + channel);
                // Trying to rejoining channel
                this.client.joinChannel(channel);
            }
        }
    }
};
