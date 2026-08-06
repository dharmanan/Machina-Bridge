// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC1155Receiver is IERC165 {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external returns (bytes4);
}

interface IERC1155 is IERC165 {
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);

    function balanceOf(address account, uint256 id) external view returns (uint256);
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory);
    function setApprovalForAll(address operator, bool approved) external;
    function isApprovedForAll(address account, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external;
}

interface IERC1155MetadataURI is IERC1155 {
    function uri(uint256 id) external view returns (string memory);
}

contract MachinaCountdown1155 is IERC1155MetadataURI {
    uint8 public constant TOTAL_DAYS = 40;

    address public owner;
    uint64 public immutable startTime;
    bool public immutable testMode;
    uint8 public testDay;

    string private metadataUri;

    mapping(uint256 => mapping(address => uint256)) private balances;
    mapping(address => mapping(address => bool)) private operatorApprovals;

    mapping(address => uint256) public claimedBitmap;
    mapping(address => uint8) public claimedCount;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DailyClaim(address indexed wallet, uint8 indexed day, uint256 indexed tokenId);
    event TestDayChanged(uint8 indexed day);
    event SmokeDayReset(address indexed wallet, uint8 indexed day);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(string memory initialMetadataUri, uint64 campaignStartTime, bool enableTestMode) {
        owner = msg.sender;
        metadataUri = initialMetadataUri;
        startTime = campaignStartTime;
        testMode = enableTestMode;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26 || interfaceId == 0x0e89341c;
    }

    function uri(uint256) external view override returns (string memory) {
        return metadataUri;
    }

    function balanceOf(address account, uint256 id) public view override returns (uint256) {
        require(account != address(0), "Zero address");
        return balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view override returns (uint256[] memory result) {
        require(accounts.length == ids.length, "Length mismatch");
        result = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            result[i] = balanceOf(accounts[i], ids[i]);
        }
    }

    function setApprovalForAll(address operator, bool approved) external override {
        require(operator != msg.sender, "Self approval");
        operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator) public view override returns (bool) {
        return operatorApprovals[account][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external override {
        require(from == msg.sender || isApprovedForAll(from, msg.sender), "Not approved");
        _transfer(from, to, id, amount, data);
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external override {
        require(from == msg.sender || isApprovedForAll(from, msg.sender), "Not approved");
        require(ids.length == amounts.length, "Length mismatch");
        require(to != address(0), "Zero address");

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 fromBalance = balances[ids[i]][from];
            require(fromBalance >= amounts[i], "Insufficient balance");
            balances[ids[i]][from] = fromBalance - amounts[i];
            balances[ids[i]][to] += amounts[i];
        }

        emit TransferBatch(msg.sender, from, to, ids, amounts);
        _checkBatchReceiver(msg.sender, from, to, ids, amounts, data);
    }

    function currentDay() public view returns (uint8) {
        if (testMode && testDay != 0) return testDay;
        if (block.timestamp < startTime) return 0;

        uint256 elapsedDays = (block.timestamp - startTime) / 1 days;
        if (elapsedDays >= TOTAL_DAYS) return TOTAL_DAYS + 1;
        return uint8(elapsedDays + 1);
    }

    function hasClaimed(address wallet, uint8 day) public view returns (bool) {
        if (day == 0 || day > TOTAL_DAYS) return false;
        return (claimedBitmap[wallet] & (uint256(1) << (day - 1))) != 0;
    }

    function claim() external {
        uint8 day = currentDay();
        require(day >= 1 && day <= TOTAL_DAYS, "Claim window closed");
        require(!hasClaimed(msg.sender, day), "Already claimed");

        claimedBitmap[msg.sender] |= uint256(1) << (day - 1);
        claimedCount[msg.sender] += 1;
        _mint(msg.sender, uint256(day), 1, "");

        emit DailyClaim(msg.sender, day, uint256(day));
    }

    function eligibilityTier(address wallet) external view returns (uint8) {
        uint8 count = claimedCount[wallet];
        if (count >= 40) return 40;
        if (count >= 30) return 30;
        if (count >= 20) return 20;
        return 0;
    }

    function claimedDays(address wallet) external view returns (uint8[] memory days) {
        uint8 count = claimedCount[wallet];
        days = new uint8[](count);
        uint256 cursor;
        for (uint8 day = 1; day <= TOTAL_DAYS; day++) {
            if (hasClaimed(wallet, day)) {
                days[cursor] = day;
                cursor++;
            }
        }
    }

    function setTestDay(uint8 day) external onlyOwner {
        require(testMode, "Test mode disabled");
        require(day >= 1 && day <= TOTAL_DAYS, "Invalid day");
        testDay = day;
        emit TestDayChanged(day);
    }

    function resetSmokeDay(address wallet, uint8 day) external onlyOwner {
        require(testMode, "Test mode disabled");
        require(day >= 1 && day <= TOTAL_DAYS, "Invalid day");
        require(hasClaimed(wallet, day), "Day not claimed");

        claimedBitmap[wallet] &= ~(uint256(1) << (day - 1));
        claimedCount[wallet] -= 1;
        _burn(wallet, uint256(day), 1);

        emit SmokeDayReset(wallet, day);
    }

    function setMetadataUri(string calldata newUri) external onlyOwner {
        metadataUri = newUri;
        emit URI(newUri, 0);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function _mint(address to, uint256 id, uint256 amount, bytes memory data) internal {
        require(to != address(0), "Zero address");
        balances[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
        _checkReceiver(msg.sender, address(0), to, id, amount, data);
    }

    function _burn(address from, uint256 id, uint256 amount) internal {
        uint256 fromBalance = balances[id][from];
        require(fromBalance >= amount, "Insufficient balance");
        balances[id][from] = fromBalance - amount;
        emit TransferSingle(msg.sender, from, address(0), id, amount);
    }

    function _transfer(address from, address to, uint256 id, uint256 amount, bytes memory data) internal {
        require(to != address(0), "Zero address");
        uint256 fromBalance = balances[id][from];
        require(fromBalance >= amount, "Insufficient balance");
        balances[id][from] = fromBalance - amount;
        balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
        _checkReceiver(msg.sender, from, to, id, amount, data);
    }

    function _checkReceiver(address operator, address from, address to, uint256 id, uint256 amount, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155Received(operator, from, id, amount, data) returns (bytes4 response) {
            require(response == IERC1155Receiver.onERC1155Received.selector, "Rejected");
        } catch {
            revert("Unsafe receiver");
        }
    }

    function _checkBatchReceiver(address operator, address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) private {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155BatchReceived(operator, from, ids, amounts, data) returns (bytes4 response) {
            require(response == IERC1155Receiver.onERC1155BatchReceived.selector, "Rejected");
        } catch {
            revert("Unsafe receiver");
        }
    }
}
