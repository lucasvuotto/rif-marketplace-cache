module.exports = {
  lint: {
    files: ['src/**/*', 'test/**/*']
  },
  depCheck: {
    ignore: [
      'sinon', 'tasegir', 'pg', 'pg-hstore', 'reflect-metadata',
      '@types/*', 'sqlite3', '@oclif/*', 'bignumber.js'
    ]
  }
}
