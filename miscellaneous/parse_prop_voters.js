const fs = require('fs');
const path = require('path');

// Define the input JSON file and output CSV file paths
const inputFilePath = path.join(__dirname, 'prop_412_voters_block_76938079.json');
const outputFilePath = path.join(__dirname, 'prop_412_voters_block_76938079.csv');

// Function to convert JSON data to CSV format
function jsonToCsv(jsonData) {
    const csvRows = ['address,vote,weight']; // CSV header

    // Group the JSON data by vote type
    const groupedData = jsonData.reduce((acc, item) => {
        const voteType = item.options[0].option;
        if (!acc[voteType]) {
            acc[voteType] = [];
        }
        acc[voteType].push(item);
        return acc;
    }, {});

    // Order the vote types with VOTE_OPTION_YES at the top
    const orderedVoteTypes = [
        'VOTE_OPTION_YES',
        ...Object.keys(groupedData).filter(voteType => voteType !== 'VOTE_OPTION_YES')
    ];

    // Convert the ordered grouped data to CSV rows
    orderedVoteTypes.forEach(voteType => {
        if (groupedData[voteType]) {
            groupedData[voteType].forEach(item => {
                const address = item.voter;
                const vote = item.options[0].option;
                const weight = item.options[0].weight;
                csvRows.push(`${address},${vote},${weight}`);
            });
        }
    });

    return csvRows.join('\n');
}


// Read the JSON file
fs.readFile(inputFilePath, 'utf8', (err, data) => {
    if (err) {
        console.error('Error reading JSON file:', err);
        return;
    }

    // Parse the JSON data
    const jsonData = JSON.parse(data);

    // Convert JSON to CSV
    const csvData = jsonToCsv(jsonData);

    // Write the CSV data to a file
    fs.writeFile(outputFilePath, csvData, 'utf8', err => {
        if (err) {
            console.error('Error writing CSV file:', err);
        } else {
            console.log('CSV file has been saved:', outputFilePath);
        }
    });
});
