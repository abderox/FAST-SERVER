var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var http = require('http');
var debug = require('debug')('backend-dl:server');
var app = express();
var cors = require('cors')
var os = require('os')
const { v4: uuidv4 } = require('uuid');
const ytdl = require('ytdl-core');
const fs = require('fs');
const ProgressBar = require('progress');






app.use(cors(
  {
    origin: '*',
  }
))
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());


var port = normalizePort(process.env.PORT || '4500');
app.set('port', port);

var server = http.createServer(app);

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    allowedHeaders: "*",
  }
})


var videos_queue = []



const socket = io.sockets.on('connection', (socket) => {
  console.log('WebSocket connection established');

  console.log("a user connected", socket.id);

  socket.on("disconnect", () => {
    console.log("user disconnected", socket.id);
  });

  socket.on("cancel",

    (data) => {
      console.log(data);
      videos_queue.forEach((video) => {
        if (video.uuid === data.uuid) {
          video.abortion = true;
        }
      })
    }

  )

})



const yt_base_url = 'https://www.youtube.com/watch?v=';
const downloadsPath = path.join(os.homedir(), 'Downloads');
const invalidCharsRegex = /[^\x00-\x7F]/;


const dl_handler = async (req, res, next) => {



  const videoUrl = req.query.url ?? yt_base_url + req.query.url;



  const videoInfo = await ytdl.getInfo(videoUrl);

  const format = ytdl.chooseFormat(videoInfo.formats, { quality: `${req.query.q}`, filter: `${req.query.t}` });

  const videoName = `${invalidCharsRegex.test(videoInfo.videoDetails.title) ? videoInfo.videoDetails.videoId : videoInfo.videoDetails.title}.${format.container}`;

  const videoPath = path.join(downloadsPath, videoName);

  const output = fs.createWriteStream(
    videoPath
  );


  let totalSize;

  let start = null;

  let bytesReceived = 0;

  let speed = 0;


  const video = ytdl(videoUrl, {
    format
  });



  try {



    video.once('response', (response) => {
      totalSize = parseInt(response.headers['content-length'], 10);
      start = Date.now();
      const uuid = uuidv4();
      videos_queue.push(
        {
          uuid: uuid,
          abortion: false
        }
      )


      socket.emit('downloadStart',
        {
          uuid
        }
      );


      const progressBar = new ProgressBar('-> downloading [:bar] :percent :etas', {
        width: 40,
        complete: '=',
        incomplete: ' ',
        renderThrottle: 1,
        total: totalSize
      });


      response.on('data', (chunk) => {

        bytesReceived += chunk.length;
        const now = Date.now();
        const elapsed = now - start;
        speed = bytesReceived / elapsed;

        if (videos_queue.find(video => video.uuid === uuid).abortion) {
          console.log('Aborting download');
          socket.emit('downloadAborted', 'Download aborted');
          video.destroy();
          output.destroy();
          // remove file
          fs.unlinkSync(
            videoPath,
            (err) => {
              if (err) {
                console.log(err);
              }
            }
          )
          videos_queue = videos_queue.filter(video => video.uuid !== uuid);
          res.send({
            message: 'aborted'
          })
        }

        else {
          socket.emit('downloadProgress',
            {
              progress: progressBar.curr,
              total: progressBar.total,
              downloadSpeed:
              {
                percentage: Math.ceil((progressBar.curr / progressBar.total) * 100),
                speed: parseFloat(speed).toFixed(2),
                timeLeft: parseFloat((totalSize - bytesReceived) / (speed * 1_000)).toFixed(2)
              }
            }
          );
          progressBar.tick(chunk.length);
        }



      })

      video.pipe(
        output
      )


      video.on('end', () => {

        console.log('Download complete');
        socket.emit('end',
          {
            message: 'Download complete',
            path: `${videoPath.replace(/\\/g, '/')}`,
            name: videoName
          }
        );
        res.json(
          {
            message: "done"
          }
        )
        // socket.disconnect();
      })
      video.on('error', (err) => {

        console.log('Error downloading video:', err);
        socket.emit('downloadError', 'Error downloading video');
        // socket.disconnect();
      });



    });

  } catch (error) {
    res.send(
      {
        error: error
      }
    )
  }




}

app.get('/video_qualities', async (req, res) => {
  const videoUrl = req.query.url ?? yt_base_url + req.query.url;
  const videoInfo = await ytdl.getInfo(videoUrl);
  // map videoInfo.formats and return quality
  const videoFormats = videoInfo.formats.filter(format => format.hasVideo && format.hasAudio);
  const qualityList = videoFormats.map(format => format.qualityLabel);
  //remove duplicates
  const uniqueQualityList = [...new Set(qualityList)];
  console.log(uniqueQualityList);
  res.send(uniqueQualityList);
})



app.get('/download', dl_handler);


// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});





server.listen(port);
server.on('error', onError);
server.on('listening', onListening);

function normalizePort(val) {
  var port = parseInt(val, 10);

  if (isNaN(port)) {
    // named pipe
    return val;
  }

  if (port >= 0) {
    // port number
    return port;
  }

  return false;
}

/**
 * Event listener for HTTP server "error" event.
 */

function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  var bind = typeof port === 'string'
    ? 'Pipe ' + port
    : 'Port ' + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */

function onListening() {
  var addr = server.address();
  var bind = typeof addr === 'string'
    ? 'pipe ' + addr
    : 'port ' + addr.port;
  debug('Listening on ' + bind);
}


