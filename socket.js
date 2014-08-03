var Player = require("./player");
var GameLobby = require("./gamelobby");
var Game = require("./assets/js/game");
var encoder = new require("node-html-encoder").Encoder("entity");
var ticker = require("./ticker");

module.exports = function(server) {
    var io = require("socket.io").listen(server);
    
    /* Global variables */
    var players = [];
    var gameList = []; // Actually game lobbies
    var gameTicker = null;
    
    /* Global methods */
    // Checks whether the given name is valid and unused
    function nameValid(name) {
        if(name.length < 3 || name.toLowerCase() === "server" || name.toLowerCase() === "you") {
            return false;
        }
    
        for(var i = 0; i < players.length; i++) {
            if(players[i].name === name) {
                return false;
            }
        }
        
        return true;
    }
    
    // Returns a player with the given name, or null
    function playerByName(name) {
        for(var i = 0; i < players.length; i++) {
            if(players[i].name === name) {
                return players[i];
            }
        }
        
        return null;
    }
    
    // Returns the game lobby with the given id, or null
    function gameById(id) {
        for(var i = 0; i < gameList.length; i++) {
            if(gameList[i].id === id) {
                return gameList[i];
            }
        }
        return null;
    }
    
    // Checks whether the given game name is valid and unused
    function gameNameValid(name) {
        if(typeof name !== "string" ||
           name.length < 3 ||
           name.substring(0, 4).toLowerCase() === "game") {
            return false;
        }
        
        for(var i = 0; i < gameList.length; i++) {
            if(gameList[i].name === name) {
                return false;
            }
        }
        
        return true;
    }
    
    // Returns a list of all game lobbies, serialized for sending
    function serializedGames() {
        var g = [];
        for(var i = 0; i < gameList.length; i++) {
            g.push(gameList[i].serialize());
        }
        return g;
    }
    
    // Deletes the game lobby with the given id
    /* jshint ignore: start */
    function deleteGame(id) {
        for(var i = 0; i < gameList.length; i++) {
            if(gameList[i].id === id) {
                gameList[i].deleteSelf();
                gameList.splice(i, 1);
                return;
            }
        }
    }
    /* jshint ignore: end */
    
    // Deletes all games with no players in them
    function cleanGameList() {
        for(var i = 0; i < gameList.length; i++) {
            if(gameList[i].players.length === 0 && gameList[i].spectators.length === 0) {
                gameList[i].deleteSelf();
                gameList.splice(i, 1);
                i--;
            }
        }
    }
    
    /* Connection handler */
    io.sockets.on("connection", function(socket) {
        console.log("A user connected via Socket.IO.");
        
        // Create a new player object
        var player = new Player(socket);
        players.push(player);
        var joined = false; // Officially joined or not
        
        socket.emit("playerid", player.id);
        
        socket.on("requestname", function(name) {
            if(!joined) {
                if(name === null) {
                    socket.emit("name", player.name);
                } else {
                    if(nameValid(name)) {
                        player.changeName(name);
                        socket.emit("name", name);
                    } else {
                        socket.emit("name", player.name);
                    }
                }
                
                // Announce their arrival
                socket.broadcast.to("chat").emit("message",
                    {tags: [{type: "info", text: "Info"}], text: player.name + " joined the server."}
                );
                
                socket.join("chat"); // Join the chat room
                socket.emit("gamelist", serializedGames());
                joined = true;
            } else { // Request to change name
                if(nameValid(name)) {                    
                    // Send name update info message
                    socket.broadcast.to("chat").emit("message",
                        {tags: [{type: "info", text: "Info"}], text: player.name + " changed their name to " + name + "."}
                    );
                    
                    player.changeName(name);
                    socket.emit("name", name);
                } else {
                    // Send error message
                    socket.emit("message",
                        {tags: [{type: "info", text: "Info"}], text: "That name is not available."}
                    );
                }
            }
        });
        
        socket.on("message", function(message) {
            var text = encoder.htmlEncode(message.text);
            if(message.to) {
                var target = playerByName(message.to);
                if(target !== null) {
                    target.socket.emit("message",
                        {tags: [{text: player.name}, {type: "info", text: "PM"}], text: text}
                    );
                } else {
                    socket.emit("message",
                        {tags: [{type: "info", text: "Info"}], text: "Player not found."}
                    );
                }
            } else {
                socket.broadcast.to("chat").emit("message",
                    {tags: [{text: player.name}], text: text}
                );
            }
        });
        
        socket.on("joingame", function(options) {
            if(player.gameLobby === null) { // Not already in a game
                var game = gameById(options.id);
                if(game !== null) {
                    var spectate = options.spectate || false;
                    
                    // Add the player to the game
                    game.addPlayer(player, spectate);
                } else {
                    socket.emit("message",
                        {tags: [{type: "info", text: "Info"}], text: "Game not found."}
                    );
                }
            }
        });
        
        socket.on("leavegame", function() {
            if(player.gameLobby !== null) {
                player.gameLobby.removePlayer(player);
            
                cleanGameList();
            }
        });
        
        socket.on("creategame", function(options) {
            if(player.gameLobby === null) { // Not already in a game
                var filtered = {}; // Filter options for safety reasons
                filtered.name = gameNameValid(options.name) ? options.name : null;
                filtered.playerCount = options.playerCount &&
                    options.playerCount >= 2 &&
                    options.playerCount <= 8 ?
                    options.playerCount : 2;
                filtered.map = options.map || "random";
                
                var game = new GameLobby(io, filtered);
                game.addPlayer(player);
                gameList.push(game);
            }
        });
        
        // Switch between spectator and player
        socket.on("togglejointype", function() {
            if(player.gameLobby !== null) {
                player.gameLobby.toggleJoinType(player);
            }
        });
        
        socket.on("leaderaction", function(data) {
            if(player.gameLobby !== null && player.gameLobby.leader.name === player.name) {
                var target = playerByName(data.target);
                if(target !== null) {
                    if(target.gameLobby !== null && target.gameLobby.id === player.gameLobby.id) {
                        if(data.action === "kick") {
                            target.gameLobby.removePlayer(target);
                            
                            cleanGameList();
                        } else if(data.action === "leader") {
                            target.gameLobby.leader = target;
                            target.gameLobby.sendUpdate();
                        }
                    }
                }
            }
        });
        
        socket.on("startgame", function() {
            if(player.gameLobby !== null && player.gameLobby.leader.name === player.name) {
                player.gameLobby.startGame();
            }
        });
        
        socket.on("makeaction", function(action) {
            if(player.gameLobby !== null && player.gameLobby.started) {
                var updateData = player.gameLobby.game.makeAction(action, player.id);
                
                socket.emit("gameupdate", updateData);
            }
        });
        
        socket.on("ping", function(id) {
            // Relay ping
            socket.emit("ping", id);
        });
        
        socket.on("disconnect", function() {
            players.splice(players.indexOf(player), 1);
            
            if(player.gameLobby !== null) {
                // Remove them from their game
                player.gameLobby.removePlayer(player);
            
                cleanGameList();
            }
            
            // Announce their departure
            socket.broadcast.to("chat").emit("message",
                {tags: [{type: "info", text: "Info"}], text: player.name + " left the server."}
            );
        });
    });
    
    // Set up game ticker
    gameTicker = ticker(function() {
        gameList.forEach(function(gameLobby) {
            if(gameLobby.started) {
                gameLobby.doGameStep();
            }
        });
    }, 1000 / Game.STEPS_PER_SECOND);
};