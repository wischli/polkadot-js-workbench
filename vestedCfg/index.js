require('@polkadot/api-augment');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { BN } = require('@polkadot/util');

async function main() {
    // 1. Connect to the Centrifuge chain via WS
    const provider = new WsProvider('wss://fullnode.centrifuge.io');
    const api = await ApiPromise.create({ provider });

    // 2. Get the last finalized block number
    const finalizedHash = await api.rpc.chain.getFinalizedHead();
    const finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);
    const currentBlock = finalizedHeader.number.toBn(); // BN of the current finalized block

    console.log(`Current finalized block number: ${currentBlock.toString()}`);

    // 3. Retrieve all vesting entries:
    //    This returns an array of [StorageKey, Option<VestingInfo[]>] tuples.
    const vestingEntries = await api.query.vesting.vesting.entries();

    // Data structures to accumulate results
    let expiredUsers = [];
    let activeUsers = [];
    let activeVesting = [];

    // Keep a running total of how much is fully vested (but unclaimed) vs. still actively vesting
    let totalFullyExpiredBalance = new BN(0);
    let totalActiveVestingBalance = new BN(0);

    for (const [storageKey, maybeVestingInfos] of vestingEntries) {
        // Extract the account ID from the storage key
        // The `storageKey` can be decoded into the accountId
        const accountId = storageKey.args[0].toString();

        // Check if this entry is None or Some( [] ), etc.
        if (maybeVestingInfos.isNone) {
            // No vesting info for this user
            continue;
        }

        const vestingInfos = maybeVestingInfos.unwrap();

        // Track how much of this user’s total vesting is fully vested vs. still locked
        let userExpired = true; // We'll mark them 'active' if ANY schedule is not fully vested
        let userFullyExpiredBalance = new BN(0);  // sum of schedule amounts that are fully vested
        let userActiveBalance = new BN(0);        // sum of amounts still vesting

        for (const info of vestingInfos) {
            const locked = new BN(info.locked.toString());
            const perBlock = new BN(info.perBlock.toString());
            const startingBlock = new BN(info.startingBlock.toString());

            // How much *should* be vested up to the current finalized block?
            // vestedSoFar = perBlock * (currentBlock - startingBlock)
            const blocksElapsed = BN.max(new BN(0), currentBlock.sub(startingBlock));
            const vestedSoFar = perBlock.mul(blocksElapsed);

            // The portion that is actually vested (but not necessarily claimed) is:
            //    min(locked, vestedSoFar)
            const fullyVestedPortion = BN.min(locked, vestedSoFar);

            // The portion that remains locked/active is:
            //    locked - fullyVestedPortion (cannot go below 0)
            const stillActivePortion = locked.sub(fullyVestedPortion);

            userFullyExpiredBalance = userFullyExpiredBalance.add(fullyVestedPortion);
            userActiveBalance = userActiveBalance.add(stillActivePortion);

            // If there is ANY stillActivePortion > 0, then this schedule isn’t fully expired
            // => the user is not "all expired"
            if (stillActivePortion.gt(new BN(0))) {
                userExpired = false;
            }
        }

        // Add the user’s portion to global totals
        totalFullyExpiredBalance = totalFullyExpiredBalance.add(userFullyExpiredBalance);
        totalActiveVestingBalance = totalActiveVestingBalance.add(userActiveBalance);

        // Bucket the user
        if (userExpired) {
            expiredUsers.push(accountId);
        } else {
            activeUsers.push(accountId);
            activeVesting.push([accountId, `${balanceToCfg(userActiveBalance).toString()} CFG`]);
        }
    }

    // 4. Report results
    console.log('---------------------');
    console.log(`Users with ALL schedules expired: ${expiredUsers.length}`);
    console.log(`Users with at least one active schedule: ${activeUsers.length}`);
    console.table(activeVesting);

    console.log(`\nTotal fully vested (unclaimed) balance: ${balanceToCfg(totalFullyExpiredBalance).toString()} CFG`);
    console.log(`Total still vesting (active) balance:    ${balanceToCfg(totalActiveVestingBalance).toString()} CFG`);

    await api.disconnect();
}

function balanceToCfg(balance) {
    return balance / 1e18;
}

main()
    .then(() => {
        console.log('Done');
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
