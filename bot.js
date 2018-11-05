import Discord from 'discord.js'
import winston from 'winston'
import loki from 'lokijs'
import config from './config.json'


// choose the enviroment variables as config if they exist
let { 
    DISCORD_TOKEN,
    THE_SHOW_CHANNEL_ID,
    THE_SHOW_VOICE_CHANNEL_ID,
    GUID_ID 
  } = process.env

if (DISCORD_TOKEN){ config.discordToken = DISCORD_TOKEN}
if (THE_SHOW_CHANNEL_ID){ config.theShowChannelId = THE_SHOW_CHANNEL_ID}
if (THE_SHOW_VOICE_CHANNEL_ID){ config.theShowVoiceChannelId = THE_SHOW_VOICE_CHANNEL_ID}
if (GUID_ID){ config.guildId = GUID_ID}

console.log(process.env.NODE_ENV)

// setup the database
let db = new loki('BNL.db', {
    autoload: true,
	autoloadCallback : databaseInitialize,
	autosave: true, 
	autosaveInterval: 4000
});

export function databaseInitialize() {
    // Database setup

    // See if the database exists.
    let waitingList = db.getCollection('waitingList')
    // if it doesn't exist then create it
    if (!waitingList) { db.addCollection('waitingList', { 
                        indices: ['timestamp'], 
                        unique: ['account'] }) 
                        waitingList = db.getCollection('waitingList')
                      }
    
    // Create document for live account
    let liveAccount = db.getCollection('liveAccount')
    // if it doesn't exist then create it
    if (!liveAccount) { 
      let liveAccount = db.addCollection('liveAccount'); 
      liveAccount.insert({live: true, id: '', dopeness: 1}) 
    } else { // if the database already exists then reset the live id when we restart
      let live = liveAccount.findOne(); 
      live.name = ''; live.id = ''; 
      live.dopeness = .5; 
      liveAccount.update(live)}
    
    // Get playStatus document
    let playStatus = db.getCollection('playStatus')
    // See if it exists
    if (!playStatus) { // It doesn't, so create it
      db.addCollection('playStatus') 
    } else { // It does, restart it
      playStatus.clear()
    }
     
    // I don't remember what any of this is for
    if (!waitingList.getDynamicView("next_up")) {
        // add empty dynamic view
        let nextUp = waitingList.addDynamicView("next_up");
    
        // apply a sort (if you need to)
        nextUp.applySimpleSort('timestamp', true);
    }

    bot() // database is set up, so lets start the bot
}

console.log(`${process.env.NODE_ENV === 'production' ? 'error' : 'debug'}`)

// Configure logger settings
const logger = winston.createLogger({
    level: `${process.env.NODE_ENV === 'production' ? 'error' : 'debug'}`,
    transports: [
      //
      // - Write to all logs with level `info` and below to `combined.log` 
      // - Write all logs error (and below) to `error.log`.
      //
      new winston.transports.File({ filename: 'error.log', level: 'error' }),
      new winston.transports.File({ filename: 'combined.log' }),
      new winston.transports.Console({colorize: true}),
    ]
  });

// Some logger function
function writeLog(message) {
    logger.log({level: 'debug', message: message})
}

// THIS IS THE MAGIC RIGHT HERE YA'LL
function bot() {
  // Initialize Discord Bot
  let bot = new Discord.Client();
  // Get all of the databases documents
  let waitingList = db.getCollection('waitingList')
  let liveAccount = db.getCollection('liveAccount')
  let playStatus = db.getCollection('playStatus')
  // Clear everything out when the bot starts
  playStatus.insert({performing: false, fresh: true})

  // When the bot is ready to rock and roll we run this
  bot.on('ready', () => {
    // this is the discord server or something
    let myGuild = bot.guilds.get(config.guildId)
    // this gets the live role in a variable, so we can assign it to people later
    let role = myGuild.roles.find(role => role.name == 'Live')

    // Remove the LIVE role from anyone who has it when the bot starts
    role.members.map(member => {
      member.roles.remove(role)
      member.setMute(true)
    })

    // send a message to the chat
    function sendChat(message) {
      return bot.channels.get(config.theShowChannelId).send(message)
    }

    // I don't remember why I made this but it's unsed
    function getNextFivePerformers() {
      return waitingList.getDynamicView('next_up').branchResultset().limit(5).data()
    }

    // Fine the next person in the performance list
    function getNextPerformer() {
      return waitingList.getDynamicView('next_up').branchResultset().limit(1).data()[0]
    }

    // Get the currently performing user
    function getLivePerformer() {
      return liveAccount.findOne()
    }

    // Set the guild member as the current performer
    function setLivePerformer(guildMember) {
      // get the current performer so we can remove them
      let member = liveAccount.findOne()
      // take the live role away from them and mute them
      role.members.forEach(member => {
        member.roles.remove(role) 
        member.setMute(true)
      })

      // assign the guid member as the perfomer if they exist
      if (guildMember) {
        // remove them from the waiting list first
        waitingList.remove(guildMember)
        // update the member variable with the new perfomer info
        member.name = guildMember.name
        member.id = guildMember.id
      } else { 
        // if the account doesn't exist there's nobody in the waiting list
        member.name = ''
        member.id = ''
      }

      // reset their score
      member.dopeness = .5
      member.dopes = 0
      member.nopes = 0
      
      // update the live perfomer with the new guild member
      return liveAccount.update(member) 
    }

    // sets the play status of the current perfomer
    // the following keys will have a boolean (true/false) value assoicated with them
    // fresh = they are starting their performance and this is the first loop
    // performing = this is an active performance happening
    function setPlayStatus(key, newStatus) {
      let status = playStatus.findOne()
      status[key] = newStatus
      return playStatus.update(status)
    }

    // get the current play status
    function getPlayStatus() {
      return playStatus.findOne()
    }

    // check their dopeness score
    function getDopeness() {
      return parseFloat(liveAccount.findOne().dopeness)
    }

    // assign the live role to someone
    function assignLiveRole(guildMember) {
      // remove the LIVE who to whoever has it currently
      role.members.map(member => member.roles.remove(role))
      // get the new performers id
      let member = myGuild.members.get(guildMember.id)
      // move them to the performing voice channel
      return member.setVoiceChannel(config.theShowVoiceChannelId)
      .then(what => {
          // give them the live role
          member.roles.add(role)
          .then(what => {
              // unmute them so they can perform
              member.setMute(false)
          })
      })
    }

    // get a message from The Show chat channel based on its ID
    function getMessage(messageId) {
      return bot.channels.get(config.theShowChannelId).messages.fetch(messageId)
    }

    // this starts the performance loop and monitors the perfomers success
    function runPerformance() {
      writeLog('starting the performance')
      // We're starting a perfomrance, so set perfomring to true
      setPlayStatus('performing', true)
      // I don't remember why this is here but i'm afraid to remove it
      setPlayStatus('fresh', false)

      // all this will be run at the end of the performance.
      bot.setTimeout(()=> {
        // Get the live performers current annoucenemnt message.
        // so we can count their emoji stats
        getMessage(getLivePerformer().message)
        .then(message => {
          // get the current performer
          let live = liveAccount.findOne()
          // filter through all the reactions to get the fire and poop count
          message.reactions.map(reaction => {
            switch(reaction.emoji.name) {
              case "🔥":
                live.dopes = reaction.count
                break
              case "💩":
                live.nopes = reaction.count
                break
              default:
            }
          })
          // do the performance math
          live.total = live.dopes + live.nopes
          live.dopeness = (parseInt(live.dopes) / parseInt(live.total)).toFixed(2)
          //update the performer stats
          liveAccount.update(live)

          setPlayStatus('performing', false)  //their current performance stops
          writeLog('ending performance')
        })
      }, 15000) // we check the performers score every 15 seconds
    }

    sendChat(`bot starting ${new Date()}`)
    // this is the main task runner. This manages the performance flows
    bot.setInterval(() => {
        writeLog("Loop start")
        writeLog(`Performing status: ${getPlayStatus().performing}`)
        // if someone is performing just log who that is
        if (getPlayStatus().performing) {
          writeLog(`${getLivePerformer().name} is performing`)
        } else {
          // no performance is currently running see if we should run one
          writeLog('no performance running')
          
          // there's performer set, so lets start their performance
          // if not then check to see if anyone is next
          if (getLivePerformer().name) {
            // someone is set to perform, so lets star their performance
            if (getPlayStatus().fresh) {
              // this is their first run, so let's set them up
              // announce to chat they're performing
              sendChat(`<@${getLivePerformer().id}> has the mic now 🎤 - Vote with 🔥 and 💩 reactions`)
              .then(message => {
                // automatically set the fire and poo emoji so people can click them
                message.react("🔥").then(what => message.react("💩"))
                let performer = getLivePerformer()
                // set the ID of the message we sent to the chat onto the perfomer document 
                // so we can easily find it later and count the emoji
                performer.message = message.id 
                // update the performer document in the db
                liveAccount.update(performer)
                // give this new performer the live role
                assignLiveRole(performer)
              })
              // start their performance
              runPerformance()

            } else if (getDopeness() > .60) { // they're no fresh, so lets count their emoji stats
              writeLog('Performer gets to continue')
              // they were dope! lets announce it to the chat
              sendChat(`<@${getLivePerformer().id}> is dope and gets to keep the mic! Dopeness score: ${getLivePerformer().dopeness}`)
              // and lets give them a new message for people to vote on
              sendChat(`<@${getLivePerformer().id}> Vote with 🔥 and 💩 reactions`)
              .then(message => {
                message.react("🔥").then(what => message.react("💩"))
                let performer = getLivePerformer()
                performer.message = message.id 
                liveAccount.update(performer)
              })
              // start a new performance for them
              runPerformance()
            } else { // ouch. they were voted off.
              writeLog(`${getLivePerformer().name} lost the mic`)
              // announce that they lost the mic, and share their score
              sendChat(`<@${getLivePerformer().id}> lost the mic! Dopeness score: ${getLivePerformer().dopeness} Need: .60`)
              .then(what => {
                  // give the next performer the microphone
                  setLivePerformer(getNextPerformer())
              })
            }
          } else {
            // nobody is currently set to perform
            writeLog('nobody is set to perform')
            // see if anyone is next to perform
            if (getNextPerformer()) {
                // we have a new performer
                writeLog('settings up next in line to perform')
                // set the play status to fresh since they're new
                setPlayStatus('fresh', true)
                // set the next performer to LIVE
                setLivePerformer(getNextPerformer())
            } else {
                // nobody is lined up to perform, so don't do anything
                writeLog('nobody is ready to perform')
            }
          }
        }
    }, 500) // run checks on the perfomance every half a second
  })

  // These are the chat commands that the bot responds to
  bot.on('message', msg => {
      // don't talk to other bots
      if (msg.author.bot) return;
  
      // Also good practice to ignore any message that does not start with our prefix, 
      // which is set in the configuration file.
      if (msg.content.indexOf('!') !== 0) return;

      // parse the chat message to get the command that was run
      let args = msg.content.substring(1).split(' ')
      let cmd = args[0]
      args = args.splice(1)

      switch(cmd) {
        // check to see if the bot is alive
        case "ping":
          msg.reply('pong')
          break
        // allow people to sign up and perform
        case "signup":
            try {
              // add the user to the waiting list
              waitingList.insert({timestamp: msg.createdTimestamp, id: msg.author.id, name: msg.author.username})
              // add them to the performance voice channel
              msg.member.setVoiceChannel(config.theShowVoiceChannelId)
              msg.reply(`You're signed up!`)
              writeLog(`${msg.member.displayName} has signed up!`)
            } catch (e) {
              msg.reply(`sign up failed, sorry!`)
            }
            break
        default:
      }
  });

  bot.login(config.discordToken)
}

process.on('SIGINT', () => {
    
    console.log("flushing database");
    // db.close() will save the database -if- any collections are marked as 'dirty'
    db.close();
    process.exit()
})