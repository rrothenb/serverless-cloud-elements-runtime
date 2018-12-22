require("regenerator-runtime/runtime");

const AWS = require('aws-sdk')

const pako = require('pako');
const {parse, stringify} = require('flatted/cjs');

function reviver(key, value) {
  if (value && value.checkpointedClassName && value.checkpointedRepresentation && revivers[value.checkpointedClassName]) {
    return revivers[value.checkpointedClassName](JSON.parse(value.checkpointedRepresentation))
  }
  return value
}

function replacer(key, value) {
  if (value && value.constructor && revivers[value.constructor.name]) {
    return {checkpointedClassName: value.constructor.name, checkpointedRepresentation: JSON.stringify(value)}
  }
  return value
}

module.exports.wrapper = function(handler) {
  let globalScope = {continuing: false, local: true}
  return async function (event, context, callback) {
    console.log('Starting at', `${new Date()}`)
    let done = false;
    let stack = {}
    if (event.Records && event.Records.length === 1 && event.Records[0].eventSource === 'aws:sqs') {
      globalScope.continuing = true;
      const compressedStack = Buffer.from(event.Records[0].body, 'base64').toString('utf-8')
      const serializedState = pako.inflate(compressedStack, {to: 'string'})
      stack = parse(serializedState, reviver).stack
      console.log('Restarting with state for', Object.keys(stack).join(', '))
    }
    while (!done) {
      try {
        const response = await handler(...arguments, {globalScope, stack: stack})
        console.log('Completed at', `${new Date()}`)
        return response
      } catch (e) {
        if (e.type === 'checkpoint') {
          if (context.invokedFunctionArn) {
            const region = context.invokedFunctionArn.split(':')[3]
            const account = context.invokedFunctionArn.split(':')[4]
            const queueName = `${context.functionName}-queue`
            const sqs = new AWS.SQS({region})
            const queueUrl = `https://sqs.${region}.amazonaws.com/${account}/${queueName}`
            return sqs.sendMessage(
              {
                MessageBody: Buffer.from(e.state).toString('base64'),
                QueueUrl: queueUrl
              }).promise().then(r => {
              callback(null, {statusCode: 202, body: 'checkpoint!'})
            })
          } else {
            globalScope.continuing = true;
            const serializedState = pako.inflate(e.state, {to: 'string'})
            stack = parse(serializedState, reviver).stack
            console.log('Restarting with state for', Object.keys(stack).join(', '))
          }
        } else {
          if (context.invokedFunctionArn && event.Records && event.Records.length === 1 && event.Records[0].eventSource === 'aws:sqs') {
            if (Number(event.Records[0].attributes.ApproximateReceiveCount) > Number(process.env.SCEP_MAX_CHECKPOINT_RETRIES)) {
              console.log(e)
              console.log(e.status)
              console.log(e.body)
              let error = e;
              if (e.status && e.response && e.response.body && e.response.body.message) {
                error = e.response.body;
                error.status = e.status;
              }
              const region = context.invokedFunctionArn.split(':')[3]
              const account = context.invokedFunctionArn.split(':')[4]
              console.log(context)
              const serviceName = context.functionName.replace(/-[^-]+-[^-]+$/, '')
              const queueName = `${serviceName}-dead-letter-queue`
              const sqs = new AWS.SQS({region})
              const queueUrl = `https://sqs.${region}.amazonaws.com/${account}/${queueName}`
              const compressedStack = Buffer.from(event.Records[0].body, 'base64').toString('utf-8')
              const serializedState = pako.inflate(compressedStack, {to: 'string'})
              return sqs.sendMessage(
                {
                  MessageBody: serializedState,
                  QueueUrl: queueUrl,
                  MessageAttributes: {
                    compressed: {
                      DataType: 'String',
                      StringValue: 'false'
                    },
                    function: {
                      DataType: 'String',
                      StringValue: context.functionName
                    },
                    error: {
                      DataType: 'String',
                      StringValue: JSON.stringify(error)
                    }
                  }
                }).promise().then(r => {
                if (e.status) {
                  if (e.status === 500) {
                    callback(null, {statusCode: 502, body: e});
                  } else {
                    callback(null, {statusCode: e.status, body: e});
                  }
                } else {
                  callback(null, {statusCode: 500, body: e});
                }
                return
              })
            }
          }
          callback(e)
          throw e;
        }
      }
    }
  }
}

module.exports.continuing = function(state) {
  return state.globalScope.continuing;
}

module.exports.buildState = function(state, functionName, context) {
  if (state.globalScope.continuing) {
    return state
  } else {
    return {globalScope: state.globalScope, stack: Object.assign(state.stack, {[functionName]: context})}
  }
}

module.exports.checkpoint = function() {
  const state = module.exports.getState(arguments)
  if (state.globalScope.continuing) {
    console.log('checkpoint', arguments[0], 'continuing...')
    state.globalScope.continuing = false;
  } else {
    if (!state.stack['$checkpoint']) {
      state.stack['$checkpoint'] = {[arguments[0]]: {start: new Date(), done: 0}}
      console.log(`Reached ${arguments[0]} checkpoint`)
    } else {
      if (state.stack['$checkpoint'][arguments[0]]) {
        state.stack['$checkpoint'][arguments[0]].done++
        const numDone = state.stack['$checkpoint'][arguments[0]].done
        const numTotal = arguments[1]
        const numRemaining = numTotal - numDone
        const percentDone = Math.round(numDone*100/numTotal)
        const timeElapsed = new Date() - new Date(state.stack['$checkpoint'][arguments[0]].start)
        const estimateRemainingTime = Math.round(timeElapsed*numRemaining/numDone)
        const estimatedCompletionDate = new Date(new Date().getTime() + estimateRemainingTime)
        console.log(
          `Reached next ${arguments[0]} checkpoint.`,
          `${percentDone}% done.`,
          `Should finish by ${estimatedCompletionDate}`)
      } else {
        state.stack['$checkpoint'] = {[arguments[0]]: {start: new Date(), done: 0}}
        console.log(`Reached ${arguments[0]} checkpoint`)
      }
    }
    const serializedState = stringify(state, replacer);
    const compressedState = pako.deflate(serializedState, {to: 'string'})
    console.log('state size:', serializedState.length, 'compressed size:', compressedState.length)
    throw {type: 'checkpoint', state: compressedState}
  }
}


module.exports.getState = function (args) {
  const state = args[args.length-1]
  return state
}

module.exports.restoreState = function(context, contextName, functionName, state) {
  context.next = state.stack[functionName][contextName].prev;
  context.prev = state.stack[functionName][contextName].prev;
  context.sent = state.stack[functionName][contextName].sent;
  state.stack[functionName][contextName] = context;
  return state.stack[functionName];
}

const revivers = {}

module.exports.register = function(classDef, reviver) {
  revivers[classDef.name] = reviver
}

module.exports.resume = async function(event, context, callback) {
  console.log(event.queryStringParameters.messageId)
  console.log(context)
  if (context.invokedFunctionArn) {
    const region = context.invokedFunctionArn.split(':')[3]
    const account = context.invokedFunctionArn.split(':')[4]
    const serviceName = context.functionName.replace(/-[^-]+-[^-]+$/, '')
    const dlqName = `${serviceName}-dead-letter-queue`
    const sqs = new AWS.SQS({region})
    const dlqUrl = `https://sqs.${region}.amazonaws.com/${account}/${dlqName}`
    while (true) {
      const response = await sqs.receiveMessage(
        {
          QueueUrl: dlqUrl,
          AttributeNames: ['All'],
          WaitTimeSeconds: 1,
          VisibilityTimeout: 5,
          MessageAttributeNames: ['All']
        }).promise()
      console.log(response)
      if (!response.Messages) {
        callback(null, {statusCode: 404, body: JSON.stringify({message: `Message ${event.queryStringParameters.messageId} not found in dead letter queue`})})
        return response
      }
      if (response.Messages.length === 1 && response.Messages[0].MessageId === event.queryStringParameters.messageId) {
        const message = response.Messages[0];
        const body = message.MessageAttributes.compressed.StringValue === 'true' ? message.Body : pako.deflate(message.Body, {to: 'string'})
        const queueName = message.MessageAttributes.function.StringValue + '-queue'
        const queueUrl = `https://sqs.${region}.amazonaws.com/${account}/${queueName}`
        console.log(body)
        console.log(queueUrl)
        const sendResponse = await sqs.sendMessage(
          {
            MessageBody: Buffer.from(body).toString('base64'),
            QueueUrl: queueUrl
          }).promise()
        console.log(sendResponse)
        const deleteResponse = await sqs.deleteMessage({
          QueueUrl: dlqUrl,
          ReceiptHandle: message.ReceiptHandle
        }).promise()
        console.log(deleteResponse)
        callback(null, {statusCode: 200, body: JSON.stringify({message: 'Message requeued'})})
        return response
      }
    }
  }
}