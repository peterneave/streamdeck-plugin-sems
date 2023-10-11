/// <reference path="libs/js/action.js" />
/// <reference path="libs/js/stream-deck.js" />

const myAction = new Action('dev.neave.sems.action');

/**
 * The first event fired when Stream Deck starts
 */
$SD.onConnected(({ actionInfo, appInfo, connection, messageType, port, uuid }) => {
	console.log('Stream Deck connected!');
});

myAction.onKeyUp(({ action, context, device, event, payload }) => {
	console.log('Your key code goes here!');

	//Get Token
	//TODO Get details from prompt
	//TODO Get settings example https://github.com/elgatosf/streamdeck-numberdisplay/blob/master/Sources/com.elgato.numberdisplay.sdPlugin/index.html

	const data = { account: "username", pwd: "password" };

	fetch("https://www.semsportal.com/api/v1/Common/CrossLogin", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Token": "{\"version\":\"v3.4.3\",\"client\":\"android\",\"language\":\"en\"}"
		},
		body: JSON.stringify(data)
	}).then(
		function (response) {
			if (response.status !== 200) {
				console.log('Looks like there was a problem. Status Code: ' +
					response.status);
				return;
			}

			// Examine the text in the response
			response.json().then(function (responseData) {
				let timestamp = responseData.data.timestamp;
				let uid = responseData.data.uid;
				let token = responseData.data.token;

				console.log(`timestamp: ${timestamp}, uid: ${uid}, token: ${token}`);
			});
		}
	)
		.catch(function (err) {
			console.log('Fetch Error :-S', err);
		});

});
