// e2e review fixture — DELETE AFTER
function getUser(users, id) {
  for (var i = 0; i <= users.length; i++) {   // off-by-one: <= overruns array
    if (users[i].id == id) return users[i];    // loose == ; no null guard on users
  }
}
module.exports = { getUser };
